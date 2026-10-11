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
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import { createReinsClient, type ReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  machineErrorSchema,
  type MachineError,
  spawnParamsSchema,
  type ProtocolMethod,
  type ConsumerContext,
  type ProtocolMessage,
  protocolRequestSchema,
  protocolResponseSchema,
  type CommandId,
  type TurnTarget,
  type TurnCompleted,
  type SessionInfo,
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
  workspaceEnvironment,
  workspaceHarnesses,
} from "./index.ts";
import { openPublications, servePublisher } from "./publications.ts";
import {
  hasQoderAuthBinding,
  projectQoderAuth,
  type QoderAuthBindings,
} from "./qoder-auth.ts";

const execute = promisify(execFile);
type Tree = Awaited<ReturnType<typeof resolveWorktree>>;
type NativeIdentity = { path: string; dev: string; ino: string };
type RecordState = {
  owner: ConsumerContext;
  tree: Tree;
  identities: NativeIdentity[];
  intent: string[];
  directory: string;
  container: string;
  environmentStage?: "pending" | "creating" | "created" | "started";
  containerId?: string;
  detach?: {
    disposition: "require_none" | "kill";
    sessionsObserved?: boolean;
  };
  completed?: TurnCompleted[];
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
  const root = options.stateDirectory;
  const publications = openPublications(root);
  const publishers = new Map<
    string,
    Awaited<ReturnType<typeof servePublisher>>
  >();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const records: RecordState[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      records.push(
        JSON.parse(
          await readFile(join(root, entry.name, "attachment.json"), "utf8"),
        ) as RecordState,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        continue;
      throw workspaceFailure("provider_failed");
    }
  }
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
  const routes = new Map<string, Promise<TransportServer<ProtocolMessage>>>();
  // 保留完整 UUID 身份，用紧凑目录避开 Unix socket 的路径长度上限。
  const controlDirectory = (record: RecordState) =>
    join(
      root,
      `c-${Buffer.from(basename(record.directory).replaceAll("-", ""), "hex").toString("base64url")}`,
    );
  const publisher = async (record: RecordState) => {
    if (publishers.has(record.directory)) return;
    const control = controlDirectory(record);
    await mkdir(join(control, "bin"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(control, "bin/reins"),
      '#!/bin/sh\nexec node /opt/reins/dist/reins-publisher.js "$@"\n',
      { mode: 0o755 },
    );
    publishers.set(
      record.directory,
      await servePublisher(join(control, "f.sock"), (params) =>
        publications.publish(record.owner, record.tree.cwd, params),
      ),
    );
  };
  for (const record of records)
    if (record.info.runtime.status !== "released") await publisher(record);
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
  const nativeLoss = async (
    record: RecordState,
  ): Promise<NativeViewLoss | undefined> => {
    for (const saved of record.identities) {
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
              return { reason: "removed" };
            throw gitError;
          }
        }
        return { reason: "unreachable" };
      }
      if (current.dev !== saved.dev || current.ino !== saved.ino)
        return {
          reason: saved.path === record.tree.root ? "replaced" : "unreachable",
        };
    }
    try {
      const tree = await resolveWorktree(record.tree.cwd);
      if (
        tree.root !== record.tree.root ||
        tree.gitDir !== record.tree.gitDir ||
        tree.commonDir !== record.tree.commonDir
      )
        return { reason: "unreachable" };
    } catch {
      return { reason: "unreachable" };
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
      if (record.owner !== owner) throw workspaceFailure("attachment_owned");
      const loss = await nativeLoss(record);
      if (
        loss === undefined &&
        record.info.source.error?.code !== "native_view_lost"
      )
        throw error;
      if (loss !== undefined) await invalidate(record, loss);
      tree = { ...record.tree, cwd };
    }
    if (record === undefined) throw workspaceFailure("attachment_not_found");
    if (record.owner !== owner) throw workspaceFailure("attachment_owned");
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
    const loss = await nativeLoss(record);
    if (loss !== undefined && record.detach === undefined)
      await invalidate(record, loss);
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
        server.onConnection((peer) => {
          const requests = new Map<string, string>();
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
                    const key = response.success
                      ? requests.get(response.output.requestId)
                      : undefined;
                    if (key !== undefined) {
                      // ACK 只由原 daemon 产生；先保存其已知结果，再原样交付。
                      await exclusive(async () => {
                        const command = record.commands?.[key];
                        if (command !== undefined) {
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
                  await persist(record);
                }
              }
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
    try {
      const client = await connect(record);
      const listed = await client.request("list", {});
      if ("error" in listed) throw listed.error;
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
      record.info.source.termination = sessions.every(
        (item) => item.outcome === "confirmed",
      )
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
  ): Promise<WorkspaceError> => {
    const error: WorkspaceError = { code: "native_view_lost", nativeView };
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
  ): Promise<NativeViewLoss | undefined> => {
    const container = await inspectContainer(record);
    if (!container.State.Running) return undefined;
    // 在原容器自己的 namespace 检查同一组原生对象；provider 调用失败不冒充分裂。
    const actual = JSON.parse(
      await docker([
        "exec",
        "-w",
        "/",
        container.Id,
        "node",
        "-e",
        "const fs=require('node:fs'),cp=require('node:child_process'),input=JSON.parse(process.argv[1]);let identities;try{identities=input.identities.map(({path})=>{const s=fs.statSync(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)}});const git=flag=>fs.realpathSync(cp.execFileSync('git',['-C',input.tree.cwd,'rev-parse','--path-format=absolute',flag],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());const tree={cwd:fs.realpathSync(input.tree.cwd),root:git('--show-toplevel'),gitDir:git('--git-dir'),commonDir:git('--git-common-dir')};console.log(JSON.stringify({identities,tree}))}catch(error){console.log(JSON.stringify({identities,error:error.code??'git_relationship_unavailable'}))}",
        JSON.stringify({ identities: record.identities, tree: record.tree }),
      ]),
    ) as { identities: NativeIdentity[]; tree: Tree; error?: string };
    if (
      actual.identities !== undefined &&
      JSON.stringify(actual.identities) !== JSON.stringify(record.identities)
    )
      return { reason: "split" };
    if (actual.error !== undefined)
      return { reason: actual.error === "ENOENT" ? "split" : "unreachable" };
    if (
      actual.tree.cwd !== record.tree.cwd ||
      actual.tree.root !== record.tree.root ||
      actual.tree.gitDir !== record.tree.gitDir ||
      actual.tree.commonDir !== record.tree.commonDir
    )
      return { reason: "split" };
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
  const status = async (cwd: string, owner: ConsumerContext) => {
    const { record, tree } = await find(cwd, owner, true);
    if (record.info.runtime.status === "ready" && record.detach === undefined) {
      let active: ManagedWorkspaceInfo["harnesses"][number] | undefined;
      try {
        if (!(await inspectContainer(record)).State.Running)
          throw workspaceFailure("runtime_resource_mismatch");
        for (const binding of record.info.harnesses) {
          active = binding;
          await validateBinding(record, binding);
        }
        active = undefined;
        const client = await connect(record);
        const list = await client.request("list", {});
        if ("error" in list) throw workspaceFailure("runtime_entry_invalid");
      } catch (error) {
        if (record.detach === undefined) {
          const failure = normalize(error);
          record.info.runtime = { status: "failed", error: failure };
          if (active !== undefined) {
            active.stage = "failed";
            active.error = failure;
          }
          await persist(record);
        }
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
    return { ...record.info, cwd: tree.cwd, definition };
  };
  const prepare = async (record: RecordState) => {
    const control = controlDirectory(record);
    const home = join(record.directory, "home");
    let active: ManagedWorkspaceInfo["harnesses"][number] | undefined;
    try {
      await mkdir(control, { recursive: true, mode: 0o700 });
      await publisher(record);
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
          `REINS_PUBLICATION_SOCKET=${join(control, "f.sock")}`,
          "--env",
          `REINS_CONSUMER_CONTEXT=${record.owner}`,
          "--env",
          `REINS_STATE_DIR=${join(control, "state")}`,
          "--env",
          `PATH=${join(control, "bin")}:/opt/reins/harnesses/codex/bin:/opt/reins/harnesses/qoder/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
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
      for (const binding of record.info.harnesses) {
        active = binding;
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
      }
      active = undefined;
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
        const loss = await nativeLoss(record);
        if (record.detach !== undefined) return;
        if (loss !== undefined) await invalidate(record, loss);
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
    publications,
    hasAttachments: () => records.some(active),
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
          if (existing.detach !== undefined)
            throw workspaceFailure("workspace_detaching");
          await find(cwd, owner);
          if (JSON.stringify(existing.intent) !== JSON.stringify(intent))
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
            history: { status: "unavailable" },
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
      const current = await status(cwd, owner);
      if (current.runtime.status !== "ready")
        throw workspaceFailure("workspace_not_ready");
      const { record, tree } = await find(cwd, owner, true);
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
        record.info.source.error?.code === "native_view_lost"
      )
        throw record.info.source.error;
      if (action === "spawn") {
        const current = await status(cwd, owner);
        if (current.runtime.status === "failed")
          throw current.runtime.error ?? workspaceFailure("provider_failed");
      }
      if (record.info.runtime.status !== "ready")
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
                        if (killed.result.status !== "killed")
                          throw workspaceFailure("provider_failed");
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
              await publishers.get(record.directory)?.close();
              publishers.delete(record.directory);
              await rm(join(controlDirectory(record), "f.sock"), {
                force: true,
              });
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
      await Promise.all(
        [...publishers.values()].map((server) => server.close()),
      );

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
