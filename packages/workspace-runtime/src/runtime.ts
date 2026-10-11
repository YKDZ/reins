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
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { createReinsClient, type ReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  type ConsumerContext,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import {
  workspaceErrorSchema,
  type ManagedWorkspaceInfo,
  type WorkspaceError,
} from "@reins/workspace-protocol";
import * as v from "valibot";

import {
  fingerprint,
  resolveWorktree,
  workspaceFailure,
  workspaceHarnesses,
} from "./index.ts";

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
      await docker(["pull", image]);
    } catch {
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
  const clients = new Map<string, ReinsClient>();
  // 保留完整 UUID 身份，用紧凑目录避开 Unix socket 的路径长度上限。
  const controlDirectory = (record: RecordState) =>
    join(
      root,
      `c-${Buffer.from(basename(record.directory).replaceAll("-", ""), "hex").toString("base64url")}`,
    );
  const preparing = new Set<string>();
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
  const find = async (cwd: string, owner: ConsumerContext) => {
    const tree = await resolveWorktree(cwd);
    const record = await locate(tree);
    if (record === undefined) throw workspaceFailure("attachment_not_found");
    if (record.owner !== owner) throw workspaceFailure("attachment_owned");
    if (record.tree.root !== tree.root)
      throw workspaceFailure("native_view_mismatch");
    const current = await Promise.all(
      record.identities.map((item) => identity(item.path)),
    );
    if (JSON.stringify(current) !== JSON.stringify(record.identities))
      throw workspaceFailure("native_view_mismatch");
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
  const status = async (cwd: string, owner: ConsumerContext) => {
    const { record, tree } = await find(cwd, owner);
    if (record.info.runtime.status === "ready") {
      try {
        if (
          (await docker([
            "inspect",
            "--format",
            "{{.State.Running}}",
            record.container,
          ])) !== "true"
        )
          throw workspaceFailure("runtime_entry_invalid");
        const client = await connect(record);
        const list = await client.request("list", {});
        if ("error" in list) throw workspaceFailure("runtime_entry_invalid");
      } catch (error) {
        record.info.runtime = { status: "failed", error: normalize(error) };
        await persist(record);
      }
    }
    return { ...record.info, cwd: tree.cwd };
  };
  const prepare = async (record: RecordState) => {
    const control = controlDirectory(record);
    const home = join(record.directory, "home");
    try {
      await mkdir(control, { recursive: true, mode: 0o700 });
      await mkdir(home, { recursive: true, mode: 0o700 });
      await ensureImage(record.info.environment.image);
      const paths = [
        ...new Set([
          record.tree.root,
          record.tree.gitDir,
          record.tree.commonDir,
          control,
          home,
        ]),
      ];
      await docker([
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
        ...(record.info.harnesses.some((binding) => binding.harness === "qoder")
          ? [
              "--env",
              "QODERCLI_PATH=/opt/reins/harnesses/qoder/bin/qoderclicn",
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
      await docker(["start", record.container]);
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
      record.info.source = { status: "verified" };
      await persist(record);
      for (const binding of record.info.harnesses) {
        binding.stage = "runtime_install";
        await persist(record);
        await ensureImage(binding.runtime.image);
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
          const archive = join(record.directory, `material-${binding.harness}`);
          await mkdir(archive, { recursive: true, mode: 0o700 });
          await docker([
            "cp",
            `${material}:/opt/reins/harnesses/${binding.harness}/.`,
            archive,
          ]);
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
        binding.stage = "runtime_validate";
        await persist(record);
        const binary = binding.harness === "codex" ? "codex" : "qoderclicn";
        const version = await docker([
          "exec",
          record.container,
          `/opt/reins/harnesses/${binding.harness}/bin/${binary}`,
          "--version",
        ]);
        if (!version.split(/\s+/u).includes(binding.runtime.version))
          throw workspaceFailure("runtime_entry_invalid");
        binding.stage = "credential_binding";
        await persist(record);
        if (binding.credential.kind !== "omitted")
          throw workspaceFailure("credential_binding_unavailable");
        binding.stage = "ready";
        await persist(record);
      }
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
      record.info.runtime = { status: "ready" };
    } catch (error) {
      const failure = normalize(error);
      record.info.runtime = { status: "failed", error: failure };
      if (failure.code === "native_view_mismatch")
        record.info.source = { status: "failed", error: failure };
      const active = record.info.harnesses.find(
        (binding) => binding.stage !== "ready",
      );
      if (active !== undefined) {
        active.stage = "failed";
        active.error = failure;
      }
      throw failure;
    } finally {
      preparing.delete(record.directory);
      await persist(record);
    }
  };
  return {
    hasAttachments: () =>
      records.some((record) => record.info.runtime.status !== "released"),
    async attach(cwd: string, bindingRefs: string[], owner: ConsumerContext) {
      v.parse(consumerContextSchema, owner);
      const tree = await resolveWorktree(cwd);
      const catalog = await workspaceHarnesses(cwd);
      if (
        bindingRefs.length === 0 ||
        new Set(bindingRefs).size !== bindingRefs.length
      )
        throw workspaceFailure("binding_conflict");
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
      const intent = bindingRefs.toSorted();
      const { record, created } = await exclusive(async () => {
        const existing = await locate(tree);
        if (existing !== undefined) {
          await find(cwd, owner);
          if (JSON.stringify(existing.intent) !== JSON.stringify(intent))
            throw workspaceFailure("attachment_intent_conflict");
          return { record: existing, created: false };
        }
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
          },
        };
        await persist(record);
        records.push(record);
        preparing.add(directory);
        return { record, created: true };
      });
      if (created) {
        // 受理只等待事实持久化；长时间 Docker 准备通过 status 观察，不占用短连接。
        void prepare(record).catch(() => {});
      } else if (record.info.runtime.status !== "preparing") {
        const current = await status(cwd, owner);
        if (current.runtime.status === "failed")
          throw current.runtime.error ?? workspaceFailure("provider_failed");
        return current;
      }
      return { ...record.info, cwd: tree.cwd };
    },
    status,
    async detach(cwd: string, owner: ConsumerContext) {
      const { record, tree } = await find(cwd, owner);
      if (preparing.has(record.directory))
        throw workspaceFailure("workspace_busy");
      if (record.info.runtime.status === "ready") {
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
    close() {
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}
