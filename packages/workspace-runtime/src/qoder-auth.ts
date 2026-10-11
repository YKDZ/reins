import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import * as v from "valibot";

import { workspaceFailure } from "./index.ts";

// 固定 QoderCN SDK 1.0.23／worker 1.1.23 的原生只读登录投影；不进入领域协议。
const absoluteFile = v.pipe(v.string(), v.check(isAbsolute));
const bindingsSchema = v.record(
  v.pipe(v.string(), v.minLength(1)),
  v.strictObject({ userFile: absoluteFile, machineIdFile: absoluteFile }),
);
export type QoderAuthBindings = v.InferOutput<typeof bindingsSchema>;

export function parseQoderAuthBindings(
  input: string | undefined,
): QoderAuthBindings {
  if (input === undefined) return {};
  try {
    return v.parse(bindingsSchema, JSON.parse(input));
  } catch {
    throw workspaceFailure("credential_binding_unavailable");
  }
}

export function hasQoderAuthBinding(
  bindings: QoderAuthBindings,
  harness: string,
  version: string,
  ref: string,
): boolean {
  return (
    harness === "qoder" && version === "1.1.23" && Object.hasOwn(bindings, ref)
  );
}

export async function projectQoderAuth(
  bindings: QoderAuthBindings,
  ref: string,
  home: string,
): Promise<void> {
  try {
    const source = Object.hasOwn(bindings, ref) ? bindings[ref] : undefined;
    if (source === undefined) throw new Error("Unconfigured binding");
    // 原生 user 是加密材料，只复制明确选定的两个文件，不解密、不扫描其他状态。
    const [user, machineId] = await Promise.all([
      readFile(source.userFile),
      readFile(source.machineIdFile),
    ]);
    if (user.length === 0 || machineId.length === 0)
      throw new Error("Empty login material");
    const directory = join(home, ".qoder-cn", ".auth");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "user"), user, { mode: 0o600 });
    await writeFile(join(directory, "machine_id"), machineId, { mode: 0o600 });
  } catch {
    // 原生文件路径、内容与解析原文均不进入错误或诊断。
    throw workspaceFailure("credential_binding_unavailable");
  }
}
