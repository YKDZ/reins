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
  machineErrorSchema,
  type MachineError,
  spawnParamsSchema,
  type ProtocolMethod,
  type ConsumerContext,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import {
  workspaceErrorSchema,
  type ManagedWorkspaceInfo,
  type WorkspaceError,
  type NativeViewLoss,
  type NativeViewTermination,
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
async function persist(record: RecordState) {
  await mkdir(record.directory, { recursive: true, mode: 0o700 });
  const target = join(record.directory, "attachment.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
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
  // 保留完整 UUID 身份，用紧凑目录避开 Unix socket 的路径长度上限。
  const controlDirectory = (record: RecordState) =>
    join(
      root,
      `c-${Buffer.from(basename(record.directory).replaceAll("-", ""), "hex").toString("base64url")}`,
    );
  const preparing = new Set<string>();
  const executions = new Map<string, Promise<void>>();
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
  const locate = async (tree: Tree) => {
    const currentRoot = await identity(tree.root);
    return records.find(
      (item) =>
        item.info.runtime.status !== "released" &&
        (item.tree.root === tree.root ||
          item.identities.some(
            (saved) =>
              saved.path === item.tree.root &&
              saved.dev === currentRoot.dev &&
              saved.ino === currentRoot.ino,
          )),
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
  ) => {
    let tree: Tree;
    let record: RecordState | undefined;
    try {
      tree = await resolveWorktree(cwd);
      record = await locate(tree);
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
    const loss = await nativeLoss(record);
    if (loss !== undefined) await invalidate(record, loss);
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
    clients.set(record.directory, client);
    client.onClosed(() => clients.delete(record.directory));
    return client;
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
  const hasReadyBinding = (record: RecordState) =>
    record.environmentStage === "started" &&
    (record.info.runtime.status === "ready" ||
      record.info.runtime.status === "failed") &&
    record.info.harnesses.some((binding) => binding.stage === "ready");
  const status = async (cwd: string, owner: ConsumerContext) => {
    const { record, tree } = await find(cwd, owner, true);
    if (
      record.info.runtime.status === "ready" ||
      (record.info.runtime.status === "failed" && hasReadyBinding(record))
    ) {
      let active: ManagedWorkspaceInfo["harnesses"][number] | undefined;
      try {
        if (!(await inspectContainer(record)).State.Running)
          throw workspaceFailure("runtime_resource_mismatch");
        for (const binding of record.info.harnesses) {
          if (binding.stage !== "ready") continue;
          active = binding;
          await validateBinding(record, binding);
        }
        active = undefined;
        const client = await connect(record);
        const list = await client.request("list", {});
        if ("error" in list) throw workspaceFailure("runtime_entry_invalid");
      } catch (error) {
        const failure = normalize(error);
        record.info.runtime = { status: "failed", error: failure };
        if (active !== undefined) {
          active.stage = "failed";
          active.error = failure;
        }
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
    return { ...record.info, cwd: tree.cwd, definition };
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
    hasAttachments: () =>
      records.some((record) => record.info.runtime.status !== "released"),
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
      await status(cwd, owner);
      const { record, tree } = await find(cwd, owner, true);
      if (!hasReadyBinding(record))
        throw workspaceFailure("workspace_not_ready");
      return {
        cwd: tree.cwd,
        socket: join(controlDirectory(record), "r.sock"),
      };
    },
    async admit(
      cwd: string,
      owner: ConsumerContext,
      action: ProtocolMethod,
      params: unknown,
    ) {
      const { record, tree } = await find(cwd, owner, true);
      if (
        ["spawn", "send", "resolvePermission"].includes(action) &&
        record.info.source.error !== undefined
      )
        throw record.info.source.error;
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
    async detach(cwd: string, owner: ConsumerContext) {
      const { record, tree } = await find(cwd, owner);
      if (preparing.has(record.directory))
        throw workspaceFailure("workspace_busy");
      if (
        Object.values(record.bindingStages ?? {}).some(
          (stage) => stage === "ready",
        )
      ) {
        const response = await (await connect(record)).request("list", {});
        if ("error" in response || response.result.length !== 0)
          throw workspaceFailure("workspace_busy");
      }
      clients.get(record.directory)?.close();
      clients.delete(record.directory);
      await docker(["rm", "-f", record.container]);
      record.info.runtime = { status: "released" };
      await persist(record);
      await rm(join(record.directory, "home"), {
        recursive: true,
        force: true,
      });
      return { ...record.info, cwd: tree.cwd };
    },
    async close() {
      clearInterval(monitor);
      await Promise.all(executions.values());
      await Promise.allSettled(observations.values());
      await Promise.allSettled(stopTasks.values());
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}
