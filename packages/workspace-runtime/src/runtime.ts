import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import { createReinsClient, type ReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  initializeResultSchema,
  protocolEventNotificationSchema,
  type DaemonGeneration,
  machineErrorSchema,
  type MachineError,
  spawnParamsSchema,
  spawnAckSchema,
  type ProtocolMethod,
  type ConsumerContext,
  type ProtocolMessage,
  protocolRequestSchema,
  protocolResponseSchema,
  type CommandId,
  type TurnTarget,
  type TurnCompleted,
  type SessionInfo,
  killResultSchema,
  sessionIdSchema,
  turnIdSchema,
  turnCompletedSchema,
  waitResultSchema,
} from "@reins/protocol";
import {
  createUnixSocketClient,
  createUnixSocketServer,
  type TransportServer,
  type TransportConnection,
} from "@reins/transport";
import {
  workspaceErrorSchema,
  type ManagedWorkspaceInfo,
  type WorkspaceError,
  type NativeViewLoss,
  type NativeViewTermination,
  type WorkspaceDetachment,
} from "@reins/workspace-protocol";
import * as v from "valibot";

import {
  hasCodexAuthBinding,
  projectCodexAuth,
  type CodexAuthBindings,
} from "./codex-auth.ts";
import {
  fingerprint,
  resolveWorktree,
  workspaceFailure,
  workspaceBindingDeclarations,
  workspaceEnvironment,
  workspaceHarnesses,
} from "./index.ts";
import {
  hasQoderAuthBinding,
  projectQoderAuth,
  type QoderAuthBindings,
} from "./qoder-auth.ts";

const execute = promisify(execFile);
type Tree = Awaited<ReturnType<typeof resolveWorktree>>;
type NativeIdentity = { path: string; dev: string; ino: string };
type SessionCwd = NativeIdentity & { sessionId: SessionInfo["sessionId"] };
type PendingSpawn = {
  sessionName: string;
  cwd: string;
  identity: NativeIdentity;
  daemonGeneration?: DaemonGeneration;
};
type NativeLossAssessment = {
  loss: NativeViewLoss;
  observation: string;
};
type RecordState = {
  owner: ConsumerContext;
  tree: Tree;
  identities: NativeIdentity[];
  intent: string[];
  bindingIntent: string;
  directory: string;
  container: string;
  environmentStage?: "pending" | "creating" | "created" | "started";
  containerId?: string;
  detach?: {
    disposition: "require_none" | "kill";
    sessionsObserved?: boolean;
  };
  completed?: TurnCompleted[];
  sessionCwds?: SessionCwd[];
  pendingSpawns?: Record<string, PendingSpawn>;
  sessionCwdConflicts?: SessionInfo["sessionId"][];
  commands?: Record<
    string,
    { fingerprint: string; pending: boolean; target?: TurnTarget }
  >;
  bindingStages?: Record<
    string,
    "pending" | "installing" | "installed" | "validated" | "ready"
  >;
  info: ManagedWorkspaceInfo;
};
async function identity(path: string): Promise<NativeIdentity> {
  const value = await stat(path, { bigint: true });
  return { path, dev: String(value.dev), ino: String(value.ino) };
}
async function loadRecords(root: string): Promise<RecordState[]> {
  const records: RecordState[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const record = JSON.parse(
        await readFile(join(root, entry.name, "attachment.json"), "utf8"),
      ) as RecordState;
      delete (record.info as ManagedWorkspaceInfo & { history?: unknown })
        .history;
      records.push(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw workspaceFailure("provider_failed");
    }
  }
  return records;
}
const writes = new WeakMap<RecordState, Promise<void>>();
function persist(record: RecordState): Promise<void> {
  // 调用顺序就是事实提交顺序，慢文件系统不能让旧快照覆盖已接受的清理意图。
  const snapshot = JSON.stringify(record);
  const next = (writes.get(record) ?? Promise.resolve())
    .catch(() => {})
    .then(() => writeRecord(record, snapshot));
  writes.set(record, next);
  return next;
}
async function writeRecord(record: RecordState, snapshot: string) {
  await mkdir(record.directory, { recursive: true, mode: 0o700 });
  const target = join(record.directory, "attachment.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(snapshot);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, target);
    const directory = await open(record.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
function normalize(error: unknown): WorkspaceError {
  const parsed = v.safeParse(workspaceErrorSchema, error);
  return parsed.success ? parsed.output : workspaceFailure("provider_failed");
}
async function docker(args: string[]) {
  try {
    return (
      await execute("docker", args, { maxBuffer: 8 * 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw workspaceFailure("provider_failed");
  }
}
async function ensureImage(image: string) {
  try {
    await docker(["image", "inspect", image]);
  } catch {
    if (image.startsWith("sha256:"))
      throw workspaceFailure("material_unavailable");
    try {
      await execute("docker", ["pull", image], { maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      const digest = image.slice(image.lastIndexOf("sha256:"));
      // 只映射真实 Docker 对请求摘要给出的完整核验失败行，不猜测其他拉取错误。
      if (
        typeof stderr === "string" &&
        stderr.trim() === `manifest verification failed for digest ${digest}`
      )
        throw workspaceFailure("material_digest_mismatch");
      throw workspaceFailure("material_unavailable");
    }
  }
}
function mount(path: string) {
  const field = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return [
    "--mount",
    ["type=bind", field(`source=${path}`), field(`target=${path}`)].join(","),
  ];
}
export async function openWorkspaceRuntime(options: {
  stateDirectory: string;
  resourcePrefix?: string;
  codexAuthBindings?: CodexAuthBindings;
  qoderAuthBindings?: QoderAuthBindings;
}) {
  // 绑定意图只保存不可逆摘要；原生来源路径与内容均不进入领域事实。
  const bindingIntent = (
    bindings: Pick<
      ManagedWorkspaceInfo["harnesses"][number],
      "ref" | "harness" | "credential"
    >[],
  ) =>
    fingerprint(
      bindings
        .toSorted((left, right) => left.ref.localeCompare(right.ref))
        .map((binding) => {
          const credential = binding.credential;
          const codex = options.codexAuthBindings ?? {};
          const qoder = options.qoderAuthBindings ?? {};
          const source =
            credential.kind === "omitted"
              ? undefined
              : binding.harness === "codex"
                ? Object.hasOwn(codex, credential.ref)
                  ? { authFile: codex[credential.ref] }
                  : undefined
                : Object.hasOwn(qoder, credential.ref)
                  ? {
                      userFile: qoder[credential.ref]!.userFile,
                      machineIdFile: qoder[credential.ref]!.machineIdFile,
                    }
                  : undefined;
          return {
            ref: binding.ref,
            harness: binding.harness,
            credential,
            source,
          };
        }),
    );
  const root = options.stateDirectory;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const records = await loadRecords(root);
  for (const record of records) {
    record.info.preparation ??= {
      attempts: [
        {
          status:
            record.info.runtime.status === "released"
              ? "ready"
              : record.info.runtime.status,
          ...(record.info.runtime.error === undefined
            ? {}
            : { error: record.info.runtime.error }),
        },
      ],
    };
    if (record.info.runtime.status === "preparing") {
      const error = workspaceFailure("preparation_interrupted");
      record.info.runtime = { status: "failed", error };
      Object.assign(record.info.preparation.attempts.at(-1)!, {
        status: "failed",
        error,
      });
      await persist(record);
    }
  }
  const clients = new Map<string, ReinsClient>();
  const clientGenerations = new WeakMap<ReinsClient, DaemonGeneration>();
  const routes = new Map<string, Promise<TransportServer<ProtocolMessage>>>();
  // 保留完整 UUID 身份，用紧凑目录避开 Unix socket 的路径长度上限。
  const controlDirectory = (record: RecordState) =>
    join(
      root,
      `c-${Buffer.from(basename(record.directory).replaceAll("-", ""), "hex").toString("base64url")}`,
    );
  const preparing = new Set<string>();
  const executions = new Map<string, Promise<void>>();
  const detachments = new Map<string, Promise<void>>();
  // 单个 Manager 对受理与发布串行化，Docker 准备在锁外进行，status 始终可观察。
  let serial = Promise.resolve();
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const result = serial.then(action);
    serial = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const active = (record: RecordState) =>
    record.info.detachment === undefined
      ? record.info.runtime.status !== "released"
      : record.info.detachment.resources.ownership.status !== "released";
  const locate = async (tree: Tree, includeReleased = false) => {
    const currentRoot = await identity(tree.root);
    const matching = records.filter(
      (item) =>
        item.tree.root === tree.root ||
        item.identities.some(
          (saved) =>
            saved.path === item.tree.root &&
            saved.dev === currentRoot.dev &&
            saved.ino === currentRoot.ino,
        ),
    );
    return (
      matching.find(active) ?? (includeReleased ? matching.at(-1) : undefined)
    );
  };
  const markSessionCwdConflict = (
    record: RecordState,
    sessionId: SessionInfo["sessionId"],
  ) => {
    record.sessionCwdConflicts ??= [];
    if (record.sessionCwdConflicts.includes(sessionId)) return false;
    record.sessionCwdConflicts.push(sessionId);
    return true;
  };
  const clearSessionCwd = (
    record: RecordState,
    sessionId: SessionInfo["sessionId"],
  ) => {
    const beforeCwds = record.sessionCwds?.length ?? 0;
    const beforeConflicts = record.sessionCwdConflicts?.length ?? 0;
    record.sessionCwds = (record.sessionCwds ?? []).filter(
      (item) => item.sessionId !== sessionId,
    );
    record.sessionCwdConflicts = (record.sessionCwdConflicts ?? []).filter(
      (item) => item !== sessionId,
    );
    return (
      beforeCwds !== record.sessionCwds.length ||
      beforeConflicts !== record.sessionCwdConflicts.length
    );
  };
  const nativeObservationSignature = (record: RecordState) =>
    JSON.stringify({
      identities: record.identities,
      sessionCwds: record.sessionCwds ?? [],
      pendingSpawns: Object.entries(record.pendingSpawns ?? {}).sort(
        ([left], [right]) => left.localeCompare(right),
      ),
      sessionCwdConflicts: record.sessionCwdConflicts ?? [],
    });
  const assessNativeLoss = (
    record: RecordState,
    loss: NativeViewLoss,
    observation = nativeObservationSignature(record),
  ): NativeLossAssessment => ({ loss, observation });
  const saveSessionCwd = (
    record: RecordState,
    sessionId: SessionInfo["sessionId"],
    saved: NativeIdentity,
  ) => {
    record.sessionCwds ??= [];
    const existing = record.sessionCwds.find(
      (item) => item.sessionId === sessionId,
    );
    if (existing !== undefined) {
      if (
        existing.path !== saved.path ||
        existing.dev !== saved.dev ||
        existing.ino !== saved.ino
      ) {
        return markSessionCwdConflict(record, sessionId);
      }
      return false;
    }
    record.sessionCwds.push({ sessionId, ...saved });
    return true;
  };
  const reconcileSessionCwds = async (record: RecordState) => {
    if (
      (record.sessionCwds?.length ?? 0) === 0 &&
      Object.keys(record.pendingSpawns ?? {}).length === 0
    )
      return;
    const client = await connect(record);
    const listed = await client.request("list", {});
    if ("error" in listed) throw listed.error;
    const sessions = listed.result;
    const daemonGeneration = clientGenerations.get(client);
    let changed = false;
    record.sessionCwds = (record.sessionCwds ?? []).filter((saved) => {
      const current = sessions.find(
        (session) => session.sessionId === saved.sessionId,
      );
      if (current === undefined) {
        return true;
      }
      if (current.state === "killed") {
        changed = clearSessionCwd(record, saved.sessionId) || changed;
        return false;
      }
      if (current.cwd !== saved.path) {
        changed = markSessionCwdConflict(record, saved.sessionId) || changed;
      }
      return true;
    });
    for (const sessionId of Array.from(record.sessionCwdConflicts ?? [])) {
      const current = sessions.find(
        (session) => session.sessionId === sessionId,
      );
      if (current?.state === "killed")
        changed = clearSessionCwd(record, sessionId) || changed;
    }
    for (const [requestId, pending] of Object.entries(
      record.pendingSpawns ?? {},
    )) {
      if (
        pending.daemonGeneration === undefined ||
        pending.daemonGeneration !== daemonGeneration
      )
        continue;
      const current = sessions.find(
        (session) =>
          session.sessionName === pending.sessionName &&
          session.cwd === pending.cwd,
      );
      if (current === undefined) continue;
      if (current.state === "killed") {
        delete record.pendingSpawns![requestId];
        changed = true;
      } else {
        changed =
          saveSessionCwd(record, current.sessionId, pending.identity) ||
          changed;
        delete record.pendingSpawns![requestId];
        changed = true;
      }
    }
    if (changed) await persist(record);
  };
  const trackSessionEvent = async (
    record: RecordState,
    event: import("@reins/protocol").DomainEvent,
    daemonGeneration: DaemonGeneration | undefined,
  ) => {
    let changed = false;
    if (event.type === "session.created" && daemonGeneration !== undefined) {
      const candidates = Object.entries(record.pendingSpawns ?? {}).filter(
        ([, pending]) =>
          pending.daemonGeneration === daemonGeneration &&
          pending.sessionName === event.sessionName,
      );
      const match =
        candidates.find(([, pending]) => pending.cwd === event.cwd) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (match !== undefined) {
        const [requestId, pending] = match;
        if (pending.cwd === event.cwd) {
          changed = saveSessionCwd(record, event.sessionId, pending.identity);
        } else {
          changed =
            saveSessionCwd(record, event.sessionId, pending.identity) ||
            changed;
          changed = markSessionCwdConflict(record, event.sessionId) || changed;
        }
        delete record.pendingSpawns![requestId];
        changed = true;
      }
    } else if (event.type === "session.killed") {
      changed = clearSessionCwd(record, event.sessionId);
    }
    if (changed) await persist(record);
  };
  const spawnCandidate = async (
    record: RecordState,
    params: unknown,
  ): Promise<PendingSpawn | undefined> => {
    const parsed = v.safeParse(spawnParamsSchema, params);
    if (!parsed.success) return undefined;
    try {
      const tree = await resolveWorktree(parsed.output.cwd);
      if (tree.root !== record.tree.root) return undefined;
      return {
        sessionName: parsed.output.sessionName,
        cwd: parsed.output.cwd,
        identity: await identity(parsed.output.cwd),
      };
    } catch {
      return undefined;
    }
  };
  const nativeLoss = async (
    record: RecordState,
  ): Promise<NativeLossAssessment | undefined> => {
    await reconcileSessionCwds(record);
    const observation = nativeObservationSignature(record);
    if ((record.sessionCwdConflicts?.length ?? 0) !== 0)
      return assessNativeLoss(record, { reason: "unreachable" }, observation);
    const pendingIdentities = Object.values(record.pendingSpawns ?? {}).map(
      (pending) => pending.identity,
    );
    for (const saved of [
      ...record.identities,
      ...(record.sessionCwds ?? []),
      ...pendingIdentities,
    ]) {
      let current: NativeIdentity;
      try {
        current = await identity(saved.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (saved.path === record.tree.root) {
          try {
            await stat(record.tree.gitDir);
          } catch (gitError) {
            if ((gitError as NodeJS.ErrnoException).code === "ENOENT")
              return assessNativeLoss(
                record,
                { reason: "removed" },
                observation,
              );
            throw gitError;
          }
        }
        return assessNativeLoss(record, { reason: "unreachable" }, observation);
      }
      if (current.dev !== saved.dev || current.ino !== saved.ino)
        return assessNativeLoss(
          record,
          {
            reason:
              saved.path === record.tree.root ? "replaced" : "unreachable",
          },
          observation,
        );
    }
    try {
      const tree = await resolveWorktree(record.tree.cwd);
      if (
        tree.root !== record.tree.root ||
        tree.gitDir !== record.tree.gitDir ||
        tree.commonDir !== record.tree.commonDir
      )
        return assessNativeLoss(record, { reason: "unreachable" }, observation);
    } catch {
      return assessNativeLoss(record, { reason: "unreachable" }, observation);
    }
    if (
      record.environmentStage === "started" &&
      record.info.source.error?.code !== "native_view_lost"
    )
      return await runtimeLoss(record);
    return undefined;
  };
  const find = async (
    cwd: string,
    owner: ConsumerContext,
    allowInvalid = false,
    observe = true,
  ) => {
    let tree: Tree;
    let record: RecordState | undefined;
    try {
      tree = await resolveWorktree(cwd);
      record = await locate(tree, true);
    } catch (error) {
      // 只有已附着原对象确实失效时，旧目录才可用于读取其事实或拒绝修改。
      record = records.find((item) => {
        const suffix = relative(item.tree.root, cwd);
        return (
          item.info.runtime.status !== "released" &&
          isAbsolute(cwd) &&
          suffix !== ".." &&
          !suffix.startsWith("../") &&
          !isAbsolute(suffix)
        );
      });
      if (record === undefined) throw error;
      if (record.owner !== owner)
        throw workspaceFailure("attachment_not_found");
      const assessment = await nativeLoss(record);
      if (
        assessment === undefined &&
        record.info.source.error?.code !== "native_view_lost"
      )
        throw error;
      if (assessment !== undefined)
        await invalidate(record, assessment.loss, assessment.observation);
      tree = { ...record.tree, cwd };
    }
    if (record === undefined) throw workspaceFailure("attachment_not_found");
    if (record.owner !== owner) throw workspaceFailure("attachment_not_found");
    if (
      record.info.source.error?.code === "native_view_lost" &&
      record.info.source.error.nativeView.reason !== "unreachable"
    ) {
      if (!allowInvalid) throw record.info.source.error;
      return { record, tree };
    }
    if (record.tree.root !== tree.root) {
      const failure = await invalidate(record, {
        reason: "moved",
        currentRoot: tree.root,
      });
      if (!allowInvalid) throw failure;
      return { record, tree };
    }
    if (record.detach !== undefined || !observe) return { record, tree };
    const assessment = await nativeLoss(record);
    if (assessment !== undefined && record.detach === undefined)
      await invalidate(record, assessment.loss, assessment.observation);
    if (!allowInvalid && record.info.source.error?.code === "native_view_lost")
      throw record.info.source.error;
    return { record, tree };
  };
  const connect = async (record: RecordState) => {
    const existing = clients.get(record.directory);
    if (existing !== undefined) return existing;
    const connection = await createUnixSocketClient<ProtocolMessage>(
      join(controlDirectory(record), "r.sock"),
    );
    const client = createReinsClient(connection, {
      consumerContext: record.owner,
    });
    const response = await client.initialize(5000);
    if ("error" in response) {
      client.close();
      throw workspaceFailure("runtime_entry_invalid");
    }
    if (record.info.runtime.status === "released") {
      client.close();
      throw workspaceFailure("workspace_detaching");
    }
    clientGenerations.set(client, response.result.daemonGeneration);
    clients.set(record.directory, client);
    client.onClosed(() => clients.delete(record.directory));
    return client;
  };
  const retainedTargets = (record: RecordState): TurnTarget[] => {
    const targets = [
      ...Object.values(record.commands ?? {}).flatMap((command) =>
        command.target === undefined ? [] : [command.target],
      ),
      ...(record.completed ?? []).map(({ sessionId, turnId }) => ({
        sessionId,
        turnId,
      })),
    ];
    return [
      ...new Map(
        targets.map((target) => [
          target.sessionId + "/" + target.turnId,
          target,
        ]),
      ).values(),
    ];
  };
  const retain = (record: RecordState, completed: TurnCompleted[] = []) => {
    record.completed ??= [];
    for (const turn of completed)
      if (
        !record.completed.some(
          (known) =>
            known.sessionId === turn.sessionId && known.turnId === turn.turnId,
        )
      )
        record.completed.push(turn);
    const detachment = record.info.detachment;
    if (detachment === undefined) return;
    for (const target of retainedTargets(record)) {
      let session = detachment.sessions.find(
        (item) => item.sessionId === target.sessionId,
      );
      if (session === undefined) {
        session = {
          sessionId: target.sessionId,
          outcome: "unknown",
          turns: [],
        };
        detachment.sessions.push(session);
      }
      let turn = session.turns.find((item) => item.turnId === target.turnId);
      if (turn === undefined) {
        turn = { turnId: target.turnId };
        session.turns.push(turn);
      }
      turn.completed ??= record.completed.find(
        (item) =>
          item.sessionId === target.sessionId && item.turnId === target.turnId,
      );
    }
    // runtime released 只在 provider 已证明环境消失后发布；不补造 harness 回合终态。
    if (detachment.resources.runtime.status === "released")
      for (const session of detachment.sessions)
        if (session.outcome === "unknown")
          session.outcome = "terminated_by_workspace_detach";
  };
  const mutable = (method: ProtocolMethod) =>
    ["spawn", "send", "resolvePermission"].includes(method);
  const routedSocket = async (record: RecordState) => {
    let route = routes.get(record.directory);
    const path = join(controlDirectory(record), "p.sock");
    if (route === undefined) {
      route = (async () => {
        await rm(path, { force: true });
        const server = createUnixSocketServer<ProtocolMessage>({ path });
        const nativeConnections = new Set<
          TransportConnection<ProtocolMessage>
        >();
        const connecting = new Set<
          Promise<TransportConnection<ProtocolMessage>>
        >();
        let closing = false;
        const deliveries = new Set<Promise<void>>();
        server.onConnection((peer) => {
          const requests = new Map<string, string>();
          const methods = new Map<string, ProtocolMethod>();
          const routeConnectionId = randomUUID();
          let generation: DaemonGeneration | undefined;
          const native = createUnixSocketClient<ProtocolMessage>(
            join(controlDirectory(record), "r.sock"),
          );
          connecting.add(native);
          void native
            .then((connection) => {
              connecting.delete(native);
              if (closing) {
                connection.close();
                peer.close();
                return;
              }
              nativeConnections.add(connection);
              let outgoing = Promise.resolve();
              connection.onEvent((event) => {
                // 保存 ACK 的异步 I/O 不得改变同一原生连接的帧顺序。
                outgoing = outgoing
                  .then(async () => {
                    if (event.kind !== "message") {
                      nativeConnections.delete(connection);
                      peer.close();
                      return;
                    }
                    const response = v.safeParse(
                      protocolResponseSchema,
                      event.message,
                    );
                    if (response.success && "result" in response.output) {
                      const initialized = v.safeParse(
                        initializeResultSchema,
                        response.output.result,
                      );
                      if (initialized.success)
                        generation = initialized.output.daemonGeneration;
                    }
                    const notification = v.safeParse(
                      protocolEventNotificationSchema,
                      event.message,
                    );
                    if (notification.success && generation !== undefined) {
                      const { event: fact } = notification.output.params;
                      const daemonGeneration = generation;
                      await exclusive(async () => {
                        await trackSessionEvent(record, fact, daemonGeneration);
                      });
                    }
                    const key = response.success
                      ? requests.get(response.output.requestId)
                      : undefined;
                    const responseId = response.success
                      ? response.output.requestId
                      : undefined;
                    const responseSpawnKey =
                      responseId === undefined
                        ? undefined
                        : `${routeConnectionId}:${responseId}`;
                    const responseMethod =
                      responseId === undefined
                        ? undefined
                        : methods.get(responseId);
                    if (responseId !== undefined) methods.delete(responseId);
                    if (
                      responseMethod === "kill" &&
                      response.success &&
                      "result" in response.output
                    ) {
                      const killed = v.safeParse(
                        killResultSchema,
                        response.output.result,
                      );
                      if (killed.success && killed.output.status === "killed") {
                        await exclusive(async () => {
                          if (clearSessionCwd(record, killed.output.sessionId))
                            await persist(record);
                        });
                      }
                    }
                    const pendingSpawn =
                      response.success && responseSpawnKey !== undefined
                        ? record.pendingSpawns?.[responseSpawnKey]
                        : undefined;
                    if (key !== undefined || pendingSpawn !== undefined) {
                      // ACK 只由原 daemon 产生；先保存其已知结果，再原样交付。
                      await exclusive(async () => {
                        const command =
                          key === undefined
                            ? undefined
                            : record.commands?.[key];
                        if (key !== undefined && command !== undefined) {
                          command.pending = false;
                          if (response.success && "result" in response.output) {
                            const target = v.safeParse(
                              v.object({
                                sessionId: sessionIdSchema,
                                turnId: turnIdSchema,
                              }),
                              response.output.result,
                            );
                            if (target.success)
                              command.target ??= target.output;
                          }
                        }
                        const spawn =
                          responseSpawnKey === undefined
                            ? undefined
                            : record.pendingSpawns?.[responseSpawnKey];
                        if (spawn !== undefined) {
                          if (response.success && "result" in response.output) {
                            const ack = v.safeParse(
                              spawnAckSchema,
                              response.output.result,
                            );
                            if (ack.success) {
                              if (ack.output.cwd === spawn.cwd) {
                                saveSessionCwd(
                                  record,
                                  ack.output.sessionId,
                                  spawn.identity,
                                );
                              } else {
                                saveSessionCwd(
                                  record,
                                  ack.output.sessionId,
                                  spawn.identity,
                                );
                                markSessionCwdConflict(
                                  record,
                                  ack.output.sessionId,
                                );
                              }
                              delete record.pendingSpawns![responseSpawnKey!];
                            }
                          } else if (
                            response.success &&
                            "error" in response.output
                          ) {
                            delete record.pendingSpawns![responseSpawnKey!];
                          }
                        }
                        retain(record);
                        await persist(record);
                      });
                      if (response.success)
                        requests.delete(response.output.requestId);
                    }
                    let completed: TurnCompleted[] = [];
                    if (response.success && "result" in response.output) {
                      const waited = v.safeParse(
                        waitResultSchema,
                        response.output.result,
                      );
                      if (waited.success) completed = waited.output.completed;
                    } else if (
                      event.message.kind === "notification" &&
                      event.message.method === "event" &&
                      event.message.params.event.type === "turn.completed"
                    ) {
                      const { type: _, ...turn } = event.message.params.event;
                      const parsed = v.safeParse(turnCompletedSchema, turn);
                      if (parsed.success) completed = [parsed.output];
                    }
                    if (completed.length !== 0)
                      await exclusive(async () => {
                        retain(record, completed);
                        await persist(record);
                      });
                    peer.send(event.message);
                  })
                  .catch(() => peer.close());
                const pending = outgoing;
                deliveries.add(pending);
                void pending.finally(() => deliveries.delete(pending));
              });
            })
            .catch(() => {
              connecting.delete(native);
              peer.close();
            });
          peer.onEvent((event) => {
            if (event.kind !== "message") {
              void native
                .then((connection) => connection.close())
                .catch(() => {});
              return;
            }
            const parsed = v.safeParse(protocolRequestSchema, event.message);
            const request = parsed.success ? parsed.output : undefined;
            const forward = async () => {
              const connection = await native;
              if (request !== undefined && mutable(request.method)) {
                const known =
                  request.commandId === undefined
                    ? undefined
                    : record.commands?.[request.commandId];
                if (
                  known === undefined &&
                  record.info.source.error?.code === "native_view_lost"
                ) {
                  peer.send({
                    kind: "response",
                    requestId: request.requestId,
                    error: record.info.source.error,
                  });
                  return;
                }
                if (record.detach !== undefined && known === undefined) {
                  peer.send({
                    kind: "response",
                    requestId: request.requestId,
                    error: { code: "workspace_detaching" },
                  });
                  return;
                }
                let changed = false;
                if (request.method === "spawn") {
                  const candidate = await spawnCandidate(
                    record,
                    request.params,
                  );
                  if (candidate !== undefined) {
                    if (generation !== undefined)
                      candidate.daemonGeneration = generation;
                    record.pendingSpawns ??= {};
                    record.pendingSpawns[
                      `${routeConnectionId}:${request.requestId}`
                    ] = candidate;
                    changed = true;
                  }
                }
                if (request.commandId !== undefined) {
                  record.commands ??= {};
                  // 原 CommandId 的冲突检查与去重仍由 daemon 负责，不替换或重试请求。
                  record.commands[request.commandId] ??= {
                    fingerprint: fingerprint({
                      method: request.method,
                      params: request.params,
                    }),
                    pending: true,
                  };
                  requests.set(request.requestId, request.commandId);
                  changed = true;
                }
                if (changed) await persist(record);
              }
              if (request !== undefined)
                methods.set(request.requestId, request.method);
              connection.send(event.message);
            };
            // 只串行化准入、落盘和写帧；原生回合、只读请求、kill 与订阅控制不占锁。
            void (
              request !== undefined && mutable(request.method)
                ? exclusive(forward)
                : forward()
            ).catch(() => peer.close());
          });
        });
        await server.listen();
        return {
          ...server,
          async close() {
            closing = true;
            for (const connection of nativeConnections) connection.close();
            nativeConnections.clear();
            await Promise.allSettled(
              [...connecting].map(async (pending) => (await pending).close()),
            );
            await server.close();
            await Promise.allSettled(deliveries);
          },
        };
      })();
      routes.set(record.directory, route);
      void route.catch(() => routes.delete(record.directory));
    }
    await route;
    return path;
  };
  const stopTasks = new Map<string, Promise<void>>();
  const machineFailure = (error: unknown): MachineError | undefined => {
    let value = error;
    if (error instanceof Error) {
      try {
        value = JSON.parse(error.message) as unknown;
      } catch {
        return undefined;
      }
    }
    const parsed = v.safeParse(machineErrorSchema, value);
    return parsed.success ? parsed.output : undefined;
  };
  const stopWorkers = async (record: RecordState) => {
    const sessions: NativeViewTermination["sessions"] = [];
    let listedIds: Set<SessionInfo["sessionId"]> | undefined;
    try {
      const client = await connect(record);
      const listed = await client.request("list", {});
      if ("error" in listed) throw listed.error;
      listedIds = new Set(listed.result.map((session) => session.sessionId));
      for (const session of listed.result) {
        if (session.state === "killed") {
          sessions.push({ sessionId: session.sessionId, outcome: "confirmed" });
          continue;
        }
        try {
          const killed = await client.request("kill", {
            sessionId: session.sessionId,
          });
          if ("error" in killed)
            sessions.push({
              sessionId: session.sessionId,
              outcome: "rejected",
              error: killed.error,
            });
          else
            sessions.push({
              sessionId: session.sessionId,
              outcome:
                killed.result.status === "killed" ? "confirmed" : "unknown",
            });
        } catch (error) {
          const failure = machineFailure(error);
          sessions.push({
            sessionId: session.sessionId,
            outcome: "unknown",
            ...(failure === undefined ? {} : { error: failure }),
          });
        }
      }
      const knownSessionIds = new Set([
        ...(record.sessionCwds ?? []).map((saved) => saved.sessionId),
        ...(record.sessionCwdConflicts ?? []),
      ]);
      for (const sessionId of knownSessionIds)
        if (!listedIds.has(sessionId))
          sessions.push({ sessionId, outcome: "unknown" });
      const unresolvedSpawns =
        Object.keys(record.pendingSpawns ?? {}).length > 0;
      record.info.source.termination =
        !unresolvedSpawns &&
        sessions.every((item) => item.outcome === "confirmed")
          ? { status: "stopped", via: "harness", sessions }
          : { status: "unknown", sessions };
    } catch (error) {
      const failure = machineFailure(error);
      record.info.source.termination = {
        status: "unknown",
        sessions,
        ...(failure === undefined ? {} : { error: failure }),
      };
    }
    await persist(record);
  };
  const invalidate = async (
    record: RecordState,
    nativeView: NativeViewLoss,
    observation?: string,
  ): Promise<WorkspaceError> => {
    const error: WorkspaceError = { code: "native_view_lost", nativeView };
    if (
      observation !== undefined &&
      observation !== nativeObservationSignature(record)
    )
      return error;
    if (record.info.source.error?.code !== "native_view_lost") {
      // 先关闭准入并持久化，再通过原 daemon 收束原会话；不重建环境或改投目录。
      record.info.source = {
        status: "failed",
        error,
        termination: { status: "stopping", sessions: [] },
      };
      await persist(record);
    } else if (
      record.info.source.error.nativeView.reason === "unreachable" &&
      nativeView.reason !== "unreachable"
    ) {
      // 先前不可达的原对象可由后来取得的原生事实细化；终止事实保持单调。
      record.info.source.error = error;
      await persist(record);
    }
    if (
      !stopTasks.has(record.directory) &&
      record.info.source.termination?.status === "stopping"
    ) {
      const task = stopWorkers(record);
      stopTasks.set(record.directory, task);
      void task
        .finally(() => stopTasks.delete(record.directory))
        .catch(() => {});
    }
    return record.info.source.error!;
  };
  const inspectContainer = async (record: RecordState) => {
    let actual: {
      Id: string;
      State: { Running: boolean };
      Config: { Labels: Record<string, string> };
    };
    try {
      actual = JSON.parse(
        await docker(["inspect", "--format", "{{json .}}", record.container]),
      );
    } catch {
      throw workspaceFailure("runtime_resource_mismatch");
    }
    if (
      record.containerId === undefined ||
      actual.Id !== record.containerId ||
      actual.Config.Labels["reins.workspace.owner"] !== fingerprint(root)
    )
      throw workspaceFailure("runtime_resource_mismatch");
    return actual;
  };
  const runtimeLoss = async (
    record: RecordState,
  ): Promise<NativeLossAssessment | undefined> => {
    const container = await inspectContainer(record);
    if (!container.State.Running) return undefined;
    const observation = nativeObservationSignature(record);
    const watchedIdentities = [
      ...record.identities,
      ...(record.sessionCwds ?? []).map(({ path, dev, ino }) => ({
        path,
        dev,
        ino,
      })),
      ...Object.values(record.pendingSpawns ?? {}).map(
        (pending) => pending.identity,
      ),
    ];
    // 在原容器自己的 namespace 检查附着目录与活跃会话 cwd；provider 调用失败不冒充分裂。
    const actual = JSON.parse(
      await docker([
        "exec",
        "-w",
        "/",
        container.Id,
        "node",
        "-e",
        "const fs=require('node:fs'),cp=require('node:child_process'),input=JSON.parse(process.argv[1]);let identities;try{identities=input.identities.map(({path})=>{const s=fs.statSync(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)}});const git=flag=>fs.realpathSync(cp.execFileSync('git',['-C',input.tree.cwd,'rev-parse','--path-format=absolute',flag],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());const tree={cwd:fs.realpathSync(input.tree.cwd),root:git('--show-toplevel'),gitDir:git('--git-dir'),commonDir:git('--git-common-dir')};console.log(JSON.stringify({identities,tree}))}catch(error){console.log(JSON.stringify({identities,error:error.code??'git_relationship_unavailable'}))}",
        JSON.stringify({ identities: watchedIdentities, tree: record.tree }),
      ]),
    ) as { identities: NativeIdentity[]; tree: Tree; error?: string };
    if (
      actual.identities !== undefined &&
      JSON.stringify(actual.identities) !== JSON.stringify(watchedIdentities)
    )
      return assessNativeLoss(record, { reason: "split" }, observation);
    if (actual.error !== undefined)
      return assessNativeLoss(
        record,
        { reason: actual.error === "ENOENT" ? "split" : "unreachable" },
        observation,
      );
    if (
      actual.tree.cwd !== record.tree.cwd ||
      actual.tree.root !== record.tree.root ||
      actual.tree.gitDir !== record.tree.gitDir ||
      actual.tree.commonDir !== record.tree.commonDir
    )
      return assessNativeLoss(record, { reason: "split" }, observation);
    return undefined;
  };
  const validateBinding = async (
    record: RecordState,
    binding: ManagedWorkspaceInfo["harnesses"][number],
  ) => {
    const binary = binding.harness === "codex" ? "codex" : "qoderclicn";
    let version: string;
    try {
      version = await docker([
        "exec",
        "-w",
        "/",
        record.container,
        `/opt/reins/harnesses/${binding.harness}/bin/${binary}`,
        "--version",
      ]);
    } catch {
      throw workspaceFailure("runtime_entry_invalid");
    }
    if (binding.harness === "qoder") {
      let workerVersion: string;
      try {
        workerVersion = await docker([
          "exec",
          record.container,
          "node",
          "/opt/reins/harnesses/qoder/worker/qoder-worker-runtime.obf.mjs",
          "--version",
        ]);
      } catch {
        throw workspaceFailure("runtime_entry_invalid");
      }
      if (workerVersion !== binding.runtime.version)
        throw workspaceFailure("runtime_entry_invalid");
    }
    if (!version.split(/\s+/u).includes(binding.runtime.version))
      throw workspaceFailure("runtime_entry_invalid");
  };
  const hasReadyBinding = (record: RecordState) =>
    record.environmentStage === "started" &&
    (record.info.runtime.status === "ready" ||
      record.info.runtime.status === "failed") &&
    record.info.harnesses.some((binding) => binding.stage === "ready");
  const status = async (cwd: string, owner: ConsumerContext) => {
    const { record, tree } = await find(cwd, owner, true);
    if (
      record.detach === undefined &&
      (record.info.runtime.status === "ready" ||
        (record.info.runtime.status === "failed" && hasReadyBinding(record)))
    ) {
      let failure: WorkspaceError | undefined;
      try {
        if (!(await inspectContainer(record)).State.Running)
          throw workspaceFailure("runtime_resource_mismatch");
        for (const binding of record.info.harnesses) {
          if (binding.stage !== "ready") continue;
          try {
            await validateBinding(record, binding);
          } catch (error) {
            if (record.detach !== undefined) break;
            const bindingFailure = normalize(error);
            binding.stage = "failed";
            binding.error = bindingFailure;
            failure ??= bindingFailure;
          }
        }
        const client = await connect(record);
        const list = await client.request("list", {});
        if ("error" in list) throw workspaceFailure("runtime_entry_invalid");
      } catch (error) {
        if (record.detach === undefined) {
          failure = normalize(error);
          // 共享容器或 daemon 失效时，所有绑定都无法继续提供执行者。
          for (const binding of record.info.harnesses) {
            if (binding.stage !== "ready") continue;
            binding.stage = "failed";
            binding.error = failure;
          }
        }
      }
      if (failure !== undefined && record.detach === undefined) {
        record.info.runtime = { status: "failed", error: failure };
        await persist(record);
      }
    }
    const attached = record.info.environment;
    let definition: NonNullable<ManagedWorkspaceInfo["definition"]>;
    try {
      const current = await workspaceEnvironment(tree.cwd);
      definition = {
        status:
          fingerprint(attached) === fingerprint(current)
            ? "unchanged"
            : "drifted",
        attached,
        current,
      };
    } catch (error) {
      definition = { status: "unavailable", attached, error: normalize(error) };
    }
    return {
      ...record.info,
      cwd: tree.cwd,
      definition,
    };
  };
  const prepare = async (record: RecordState) => {
    const control = controlDirectory(record);
    const home = join(record.directory, "home");
    let active: ManagedWorkspaceInfo["harnesses"][number] | undefined;
    try {
      await mkdir(control, { recursive: true, mode: 0o700 });
      await mkdir(home, { recursive: true, mode: 0o700 });
      const paths = [
        ...new Set([
          record.tree.root,
          record.tree.gitDir,
          record.tree.commonDir,
          control,
          home,
        ]),
      ];
      if (
        record.environmentStage === "creating" ||
        record.environmentStage === undefined
      )
        throw workspaceFailure("preparation_outcome_unknown");
      if (record.environmentStage === "pending") {
        await ensureImage(record.info.environment.image);
        record.environmentStage = "creating";
        await persist(record);
        record.containerId = await docker([
          "create",
          "--name",
          record.container,
          "--label",
          "reins.workspace.managed=true",
          "--label",
          `reins.workspace.owner=${fingerprint(root)}`,
          ...paths.flatMap(mount),
          "--workdir",
          record.tree.cwd,
          "--env",
          `HOME=${home}`,
          "--env",
          `CODEX_HOME=${join(home, ".codex")}`,
          ...(record.info.harnesses.some(
            (binding) => binding.harness === "qoder",
          )
            ? [
                "--env",
                "QODERCLI_PATH=/opt/reins/harnesses/qoder/worker/qoder-worker-runtime.obf.mjs",
                "--env",
                `QODERCN_CONFIG_DIR=${join(home, ".qoder-cn")}`,
              ]
            : []),
          "--env",
          `REINS_SOCKET=${join(control, "r.sock")}`,
          "--env",
          `REINS_CONSUMER_CONTEXT=${record.owner}`,
          "--env",
          `REINS_STATE_DIR=${join(control, "state")}`,
          "--env",
          "PATH=/opt/reins/harnesses/codex/bin:/opt/reins/harnesses/qoder/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "--entrypoint",
          "node",
          record.info.environment.image,
          "/opt/reins/dist/reins-daemon.js",
        ]);
        record.environmentStage = "created";
        await persist(record);
      }
      const actualContainer = await inspectContainer(record);
      if (record.environmentStage === "created") {
        if (!actualContainer.State.Running)
          await docker(["start", record.container]);
        record.environmentStage = "started";
        await persist(record);
      } else if (!actualContainer.State.Running) {
        throw workspaceFailure("runtime_resource_mismatch");
      }
      // 使用容器自己的 Node 与 Git 验证本地真实入口和直接 bind 身份，不传输源码。
      const actual = JSON.parse(
        await docker([
          "exec",
          record.container,
          "node",
          "-e",
          "const fs=require('node:fs');console.log(JSON.stringify(process.argv.slice(1).map(path=>{const s=fs.statSync(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)}})))",
          ...record.identities.map((item) => item.path),
        ]),
      ) as NativeIdentity[];
      if (JSON.stringify(actual) !== JSON.stringify(record.identities))
        throw workspaceFailure("native_view_mismatch");
      const actualRoot = await docker([
        "exec",
        record.container,
        "git",
        "-C",
        record.tree.cwd,
        "rev-parse",
        "--show-toplevel",
      ]);
      if (actualRoot !== record.tree.root)
        throw workspaceFailure("native_view_mismatch");
      await docker([
        "exec",
        record.container,
        "node",
        "-e",
        "if(process.platform!=='linux'||process.arch!=='x64'||process.versions.node.split('.')[0]!=='24')process.exit(1);const fs=require('node:fs'),p=process.env.HOME+'/reins-home-probe-'+process.pid;const fd=fs.openSync(p,'wx',0o600);fs.closeSync(fd);fs.unlinkSync(p)",
      ]);
      if (record.info.source.error?.code === "native_view_lost")
        throw record.info.source.error;
      record.info.source = { status: "verified" };
      await persist(record);
      // 提前保持真实控制连接；部分绑定失败或安装较慢时 daemon 不因空闲丢失已有环境。
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          await connect(record);
          break;
        } catch {
          if (Date.now() >= deadline)
            throw workspaceFailure("runtime_entry_invalid");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      record.bindingStages ??= {};
      let bindingFailure: WorkspaceError | undefined;
      for (const binding of record.info.harnesses) {
        active = binding;
        try {
          const checkpoint = record.bindingStages[binding.ref] ?? "pending";
          if (checkpoint === "ready") {
            await validateBinding(record, binding);
            binding.stage = "ready";
            delete binding.error;
            await persist(record);
            continue;
          }
          if (checkpoint === "installing")
            throw workspaceFailure("preparation_outcome_unknown");
          delete binding.error;
          if (checkpoint === "pending") {
            binding.stage = "runtime_install";
            await persist(record);
            await ensureImage(binding.runtime.image);
            record.bindingStages[binding.ref] = "installing";
            await persist(record);
            const material = `${record.container}-material-${binding.harness}`;
            let materialCreated = false;
            try {
              await docker([
                "create",
                "--name",
                material,
                "--label",
                `reins.workspace.owner=${fingerprint(root)}`,
                "--entrypoint",
                "node",
                binding.runtime.image,
                "--version",
              ]);
              materialCreated = true;
              const archive = join(
                record.directory,
                `material-${binding.harness}`,
              );
              await mkdir(archive, { recursive: true, mode: 0o700 });
              try {
                await execute(
                  "docker",
                  [
                    "cp",
                    `${material}:/opt/reins/harnesses/${binding.harness}/.`,
                    archive,
                  ],
                  { maxBuffer: 8 * 1024 * 1024 },
                );
              } catch (error) {
                const stderr = (error as { stderr?: unknown }).stderr;
                // 仅本地接收目录的原生写入容量失败已知未触及运行容器，可显式重做接收。
                if (
                  typeof stderr === "string" &&
                  stderr.trim().startsWith(`write ${archive}/`) &&
                  stderr.trim().endsWith(": no space left on device") &&
                  !stderr.trim().includes("\n")
                ) {
                  record.bindingStages[binding.ref] = "pending";
                  throw workspaceFailure("capacity_exhausted");
                }
                throw workspaceFailure("provider_failed");
              }
              await docker([
                "exec",
                record.container,
                "mkdir",
                "-p",
                `/opt/reins/harnesses/${binding.harness}`,
              ]);
              await docker([
                "cp",
                `${archive}/.`,
                `${record.container}:/opt/reins/harnesses/${binding.harness}`,
              ]);
            } finally {
              if (materialCreated) await docker(["rm", "-f", material]);
            }
            record.bindingStages[binding.ref] = "installed";
            await persist(record);
          }
          binding.stage = "runtime_validate";
          await persist(record);
          await validateBinding(record, binding);
          record.bindingStages[binding.ref] = "validated";
          binding.stage = "credential_binding";
          await persist(record);
          if (binding.credential.kind === "bound") {
            const bindings = options.codexAuthBindings ?? {};
            if (
              hasQoderAuthBinding(
                options.qoderAuthBindings ?? {},
                binding.harness,
                binding.runtime.version,
                binding.credential.ref,
              )
            ) {
              await projectQoderAuth(
                options.qoderAuthBindings ?? {},
                binding.credential.ref,
                home,
              );
            } else {
              if (
                !hasCodexAuthBinding(
                  bindings,
                  binding.harness,
                  binding.runtime.version,
                  binding.credential.ref,
                )
              )
                throw workspaceFailure("credential_binding_unavailable");
              await projectCodexAuth(bindings, binding.credential.ref, home);
            }
          }
          record.bindingStages[binding.ref] = "ready";
          binding.stage = "ready";
          await persist(record);
        } catch (error) {
          const failure = normalize(error);
          bindingFailure ??= failure;
          binding.stage = "failed";
          binding.error = failure;
          await persist(record);
        }
      }
      active = undefined;
      if (bindingFailure !== undefined) throw bindingFailure;
      record.info.runtime = { status: "ready" };
      record.info.preparation.attempts.at(-1)!.status = "ready";
    } catch (error) {
      const failure = normalize(error);
      record.info.runtime = { status: "failed", error: failure };
      Object.assign(record.info.preparation.attempts.at(-1)!, {
        status: "failed",
        error: failure,
      });
      if (failure.code === "native_view_mismatch")
        record.info.source = { status: "failed", error: failure };
      const failedBinding =
        active ??
        record.info.harnesses.find((binding) => binding.stage !== "ready");
      if (failedBinding !== undefined) {
        failedBinding.stage = "failed";
        failedBinding.error = failure;
      }
      throw failure;
    } finally {
      await persist(record);
      preparing.delete(record.directory);
    }
  };
  const observations = new Map<string, Promise<void>>();
  const monitor = setInterval(() => {
    for (const record of records) {
      if (
        record.environmentStage !== "started" ||
        record.detach !== undefined ||
        observations.has(record.directory) ||
        record.info.runtime.status === "released"
      )
        continue;
      if (
        record.info.source.status !== "verified" &&
        record.info.source.error?.code !== "native_view_lost"
      )
        continue;
      const observation = (async () => {
        const assessment = await nativeLoss(record);
        if (record.detach !== undefined) return;
        if (assessment !== undefined)
          await invalidate(record, assessment.loss, assessment.observation);
        else if (record.info.source.error?.code === "native_view_lost")
          await invalidate(record, record.info.source.error.nativeView);
      })();
      observations.set(record.directory, observation);
      void observation
        .finally(() => observations.delete(record.directory))
        .catch(() => {});
    }
  }, 1000);
  monitor.unref();
  return {
    hasAttachments: () => records.some(active),
    // 独立管理程序在同一 state lease 下调用；不登记到 agent 协议。
    async inspectAttachment(cwd: string) {
      const record = await locate(await resolveWorktree(cwd), true);
      if (record === undefined) throw workspaceFailure("attachment_not_found");
      const runtime = await (async () => {
        try {
          const ids = await docker([
            "container",
            "ls",
            "-a",
            "--no-trunc",
            "--filter",
            record.containerId === undefined
              ? "name=^/" + record.container + "$"
              : "id=" + record.containerId,
            "--format",
            "{{.ID}}",
          ]);
          if (ids === "") return { status: "absent" as const };
          const inspected = await inspectContainer(record);
          return {
            status: "present" as const,
            containerId: ids,
            running: inspected.State.Running,
          };
        } catch {
          return {
            status: "unknown" as const,
            error: workspaceFailure("provider_failed"),
          };
        }
      })();
      const sessions = await (async () => {
        if (runtime.status === "absent")
          return { status: "unavailable" as const };
        try {
          const response = await (await connect(record)).request("list", {});
          if ("error" in response) throw response.error;
          return { status: "available" as const, sessions: response.result };
        } catch {
          return {
            status: "unknown" as const,
            error: workspaceFailure("runtime_entry_invalid"),
          };
        }
      })();
      return {
        consumerContext: record.owner,
        ownership: active(record)
          ? ("attached" as const)
          : ("released" as const),
        attachment: record.info,
        runtime,
        sessions,
      };
    },
    async attach(cwd: string, bindingRefs: string[], owner: ConsumerContext) {
      v.parse(consumerContextSchema, owner);
      const tree = await resolveWorktree(cwd);
      if (
        bindingRefs.length === 0 ||
        new Set(bindingRefs).size !== bindingRefs.length
      )
        throw workspaceFailure("binding_conflict");
      const intent = bindingRefs.toSorted();
      const { record, created } = await exclusive(async () => {
        const existing = await locate(tree);
        if (existing !== undefined) {
          if (existing.owner !== owner)
            throw workspaceFailure("attachment_owned");
          if (existing.detach !== undefined)
            throw workspaceFailure("workspace_detaching");
          await find(cwd, owner);
          if (JSON.stringify(existing.intent) !== JSON.stringify(intent))
            throw workspaceFailure("attachment_intent_conflict");
          const current = await workspaceBindingDeclarations(cwd);
          const selected = intent.map((ref) =>
            current.find((binding) => binding.ref === ref),
          );
          if (
            selected.some((binding) => binding === undefined) ||
            existing.bindingIntent !==
              bindingIntent(
                selected as NonNullable<(typeof selected)[number]>[],
              )
          )
            throw workspaceFailure("attachment_intent_conflict");
          if (existing.info.runtime.status === "failed")
            await executions.get(existing.directory);
          if (
            !preparing.has(existing.directory) &&
            existing.info.runtime.status === "failed"
          ) {
            existing.info.runtime = { status: "preparing" };
            existing.info.preparation.attempts.push({ status: "preparing" });
            await persist(existing);
            preparing.add(existing.directory);
            return { record: existing, created: true };
          }
          return { record: existing, created: false };
        }
        const catalog = await workspaceHarnesses(
          cwd,
          options.codexAuthBindings,
          options.qoderAuthBindings,
        );
        const selected = bindingRefs.map((ref) => {
          const binding = catalog.bindings.find((item) => item.ref === ref);
          if (binding === undefined)
            throw {
              code: "binding_unknown",
              availableBindings: catalog.bindings.map((item) => item.ref),
            } satisfies WorkspaceError;
          return binding;
        });
        if (
          new Set(selected.map((binding) => binding.harness)).size !==
          selected.length
        )
          throw workspaceFailure("binding_conflict");
        const identities = await Promise.all(
          [
            ...new Set([
              tree.root,
              tree.cwd,
              join(tree.root, ".git"),
              tree.gitDir,
              tree.commonDir,
            ]),
          ].map(identity),
        );
        const directory = join(root, randomUUID());
        const record: RecordState = {
          owner,
          tree,
          identities,
          intent,
          bindingIntent: bindingIntent(selected),
          directory,
          environmentStage: "pending",
          container: `${options.resourcePrefix ?? "reins-workspace"}-${randomUUID()}`,
          info: {
            cwd: tree.cwd,
            root: tree.root,
            source: { status: "pending" },
            runtime: { status: "preparing" },
            environment: catalog.environment,
            environmentFingerprint: catalog.environmentFingerprint,
            harnesses: selected.map(({ compatibility: _, ...binding }) => ({
              ...binding,
              stage: "pending",
            })),
            preparation: { attempts: [{ status: "preparing" }] },
          },
        };
        await persist(record);
        records.push(record);
        preparing.add(directory);
        return { record, created: true };
      });
      if (created) {
        // 受理只等待事实持久化；长时间 Docker 准备通过 status 观察，不占用短连接。
        const execution = prepare(record).catch(() => {});
        executions.set(record.directory, execution);
        void execution.finally(() => executions.delete(record.directory));
      } else if (record.info.runtime.status !== "preparing") {
        const current = await status(cwd, owner);
        if (current.runtime.status === "failed")
          throw current.runtime.error ?? workspaceFailure("provider_failed");
        return current;
      }
      return { ...record.info, cwd: tree.cwd };
    },
    status,
    async route(cwd: string, owner: ConsumerContext) {
      await status(cwd, owner);
      const { record, tree } = await find(cwd, owner, true);
      if (!hasReadyBinding(record))
        throw workspaceFailure("workspace_not_ready");
      return {
        cwd: tree.cwd,
        socket: await routedSocket(record),
      };
    },
    async admit(
      cwd: string,
      owner: ConsumerContext,
      action: ProtocolMethod,
      params: unknown,
      commandId?: CommandId,
    ) {
      const { record, tree } = await find(cwd, owner, true);
      // 已转发命令的显式恢复仍交原 daemon 裁决去重、冲突与运行代际。
      if (
        mutable(action) &&
        commandId !== undefined &&
        record.commands?.[commandId] !== undefined
      )
        return { cwd: tree.cwd };
      if (mutable(action) && record.detach !== undefined)
        throw workspaceFailure("workspace_detaching");
      if (
        ["spawn", "send", "resolvePermission"].includes(action) &&
        record.info.source.error !== undefined
      )
        throw record.info.source.error;
      if (action === "spawn") {
        const current = await status(cwd, owner);
        if (record.info.source.error !== undefined)
          throw record.info.source.error;
        if (current.runtime.status === "failed" && !hasReadyBinding(record))
          throw current.runtime.error ?? workspaceFailure("provider_failed");
      }
      if (!hasReadyBinding(record))
        throw workspaceFailure("workspace_not_ready");
      if (action === "spawn") {
        const supplied = v.safeParse(spawnParamsSchema, params);
        if (!supplied.success) throw workspaceFailure("invalid_request");
        const execution = await resolveWorktree(supplied.output.cwd);
        if (execution.root !== record.tree.root)
          throw workspaceFailure("invalid_directory");
        const binding = record.info.harnesses.find(
          (item) => item.harness === supplied.output.harness,
        );
        if (binding === undefined) throw workspaceFailure("binding_unknown");
        if (binding.stage !== "ready")
          throw workspaceFailure("harness_not_prepared");
      }
      return { cwd: tree.cwd };
    },
    async detach(
      cwd: string,
      owner: ConsumerContext,
      disposition: "require_none" | "kill",
    ) {
      const { record, tree } = await find(cwd, owner, true, false);
      let listed: SessionInfo[] = [];
      await exclusive(async () => {
        if (record.detach !== undefined) {
          if (record.detach.disposition === disposition) return;
          if (disposition !== "kill") throw workspaceFailure("invalid_request");
          record.detach.disposition = "kill";
          record.info.detachment!.disposition = "kill";
          await persist(record);
          return;
        }
        if (preparing.has(record.directory))
          throw workspaceFailure("workspace_busy");
        if (disposition === "require_none") {
          if (
            Object.values(record.commands ?? {}).some(
              (command) => command.pending,
            )
          )
            throw workspaceFailure("workspace_busy");
          if (record.environmentStage === "started") {
            const response = await (await connect(record)).request("list", {});
            if (
              "error" in response ||
              response.result.some((session) => session.state !== "killed")
            )
              throw workspaceFailure("workspace_busy");
            listed = response.result;
          }
        }
        record.detach = {
          disposition,
          ...(disposition === "require_none" ? { sessionsObserved: true } : {}),
        };
        record.info.detachment = {
          disposition,
          status: "detaching",
          sessions: [],
          resources: {
            runtime: { status: "pending" },
            credentials: { status: "pending" },
            bindings: { status: "pending" },
            routing: { status: "pending" },
            ownership: { status: "pending" },
          },
        };
        retain(record);
        for (const session of listed) {
          const saved = record.info.detachment.sessions.find(
            (item) => item.sessionId === session.sessionId,
          );
          if (saved === undefined)
            record.info.detachment.sessions.push({
              sessionId: session.sessionId,
              session,
              outcome: "confirmed",
              turns: [],
            });
          else {
            saved.session = session;
            saved.outcome = "confirmed";
          }
        }
        await persist(record);
      });
      const detachment = record.info.detachment!;
      let cleanup = detachments.get(record.directory);
      if (cleanup === undefined && detachment.status !== "released") {
        cleanup = (async () => {
          let step: keyof WorkspaceDetachment["resources"] | undefined;
          try {
            detachment.status = "detaching";
            delete detachment.error;
            await persist(record);
            const runtimeAbsent = async () =>
              (await docker([
                "container",
                "ls",
                "-a",
                "--no-trunc",
                "--filter",
                record.containerId === undefined
                  ? "name=^/" + record.container + "$"
                  : "id=" + record.containerId,
                "--format",
                "{{.ID}}",
              ])) === "";
            if (detachment.resources.runtime.status !== "released") {
              step = "runtime";
              const absent = await runtimeAbsent();
              if (!absent) {
                const client =
                  record.environmentStage === "started" &&
                  (!record.detach!.sessionsObserved ||
                    detachment.sessions.some(
                      (session) => session.outcome !== "confirmed",
                    ))
                    ? await connect(record)
                    : undefined;
                if (client !== undefined) {
                  if (detachment.disposition === "kill") {
                    const response = await client.request("list", {});
                    if ("error" in response) throw response.error;
                    listed = response.result;
                    record.detach!.sessionsObserved = true;
                  }
                  for (const session of listed) {
                    let saved = detachment.sessions.find(
                      (item) => item.sessionId === session.sessionId,
                    );
                    if (saved === undefined) {
                      saved = {
                        sessionId: session.sessionId,
                        outcome: "unknown",
                        turns: [],
                      };
                      detachment.sessions.push(saved);
                    }
                    saved.session = session;
                    if (session.state === "killed") saved.outcome = "confirmed";
                    for (const turnId of [
                      ...(session.state === "busy"
                        ? [session.activeTurnId]
                        : []),
                      ...(session.lastCompletedTurn === undefined
                        ? []
                        : [session.lastCompletedTurn.turnId]),
                    ])
                      if (!saved.turns.some((turn) => turn.turnId === turnId))
                        saved.turns.push({ turnId });
                  }
                  const saveTurns = async () => {
                    const targets = detachment.sessions.flatMap((session) =>
                      session.turns.map((turn) => ({
                        sessionId: session.sessionId,
                        turnId: turn.turnId,
                      })),
                    );
                    if (targets.length !== 0) {
                      const waited = await client.request("wait", {
                        targets,
                        completion: "all",
                        timeoutMs: 0,
                      });
                      if ("result" in waited)
                        retain(record, waited.result.completed);
                    }
                    await persist(record);
                  };
                  await saveTurns();
                  if (detachment.disposition === "kill")
                    for (const session of detachment.sessions) {
                      if (session.outcome === "confirmed") continue;
                      try {
                        const killed = await client.request("kill", {
                          sessionId: session.sessionId,
                        });
                        if ("error" in killed) {
                          session.error = killed.error;
                          throw killed.error;
                        }
                        // 重启前的身份不能由当前 daemon 确认；保留 unknown，
                        // 仅在下方实际证明容器消失后发布 provider 终止事实。
                        if (killed.result.status === "not_found") continue;
                        session.outcome = "confirmed";
                        delete session.error;
                        await saveTurns();
                      } catch (error) {
                        const failure = machineFailure(error);
                        if (failure !== undefined) session.error = failure;
                        await persist(record);
                        throw error;
                      }
                    }
                }
                await docker(["rm", "-f", record.container]);
                if (!(await runtimeAbsent()))
                  throw workspaceFailure("provider_failed");
              }
              clients.get(record.directory)?.close();
              clients.delete(record.directory);
              record.info.runtime = { status: "released" };
              detachment.resources.runtime = { status: "released" };
              retain(record);
              await persist(record);
            }
            if (detachment.resources.credentials.status !== "released") {
              step = "credentials";
              await rm(join(record.directory, "home"), {
                recursive: true,
                force: true,
              });
              detachment.resources.credentials = { status: "released" };
              await persist(record);
            }
            if (detachment.resources.bindings.status !== "released") {
              step = "bindings";
              for (const binding of record.info.harnesses)
                binding.stage = "released";
              detachment.resources.bindings = { status: "released" };
              await persist(record);
            }
            if (detachment.resources.routing.status !== "released") {
              step = "routing";
              await (await routes.get(record.directory))?.close();
              routes.delete(record.directory);
              await rm(join(controlDirectory(record), "p.sock"), {
                force: true,
              });
              await rm(join(controlDirectory(record), "r.sock"), {
                force: true,
              });
              detachment.resources.routing = { status: "released" };
              await persist(record);
            }
            step = "ownership";
            detachment.resources.ownership = { status: "released" };
            detachment.status = "released";
            delete detachment.error;
            await persist(record);
          } catch (error) {
            const failure = normalize(error);
            detachment.status = "failed";
            detachment.error = failure;
            if (
              step !== undefined &&
              detachment.resources[step].status !== "released"
            )
              detachment.resources[step] = { status: "failed", error: failure };
            await persist(record);
            throw failure;
          }
        })();
        detachments.set(record.directory, cleanup);
        const finished = () => {
          if (detachments.get(record.directory) === cleanup)
            detachments.delete(record.directory);
        };
        void cleanup.then(finished, finished);
      }
      await cleanup;
      return { ...record.info, cwd: tree.cwd };
    },
    async close() {
      clearInterval(monitor);
      await Promise.all(executions.values());

      await Promise.allSettled(observations.values());
      await Promise.allSettled(stopTasks.values());
      for (const client of clients.values()) client.close();
      clients.clear();
      await Promise.allSettled(
        [...routes.values()].map(async (route) => (await route).close()),
      );
      routes.clear();
    },
  };
}
