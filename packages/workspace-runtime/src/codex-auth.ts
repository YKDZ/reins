import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import * as v from "valibot";

import { workspaceFailure } from "./index.ts";

// 这是固定 Codex/Docker 支持包的部署输入，不进入工作区协议或持久领域记录。
export const codexAuthBindingsSchema = v.record(
  v.pipe(v.string(), v.minLength(1)),
  v.pipe(v.string(), v.check(isAbsolute)),
);
export type CodexAuthBindings = v.InferOutput<typeof codexAuthBindingsSchema>;

export function parseCodexAuthBindings(
  input: string | undefined,
): CodexAuthBindings {
  if (input === undefined) return {};
  try {
    return v.parse(codexAuthBindingsSchema, JSON.parse(input));
  } catch {
    throw workspaceFailure("credential_binding_unavailable");
  }
}

export function hasCodexAuthBinding(
  bindings: CodexAuthBindings,
  harness: string,
  version: string,
  ref: string,
): boolean {
  return (
    harness === "codex" && version === "0.162.0" && Object.hasOwn(bindings, ref)
  );
}

const token = v.pipe(v.string(), v.minLength(1));
const loginSchema = v.object({
  auth_mode: v.literal("chatgpt"),
  tokens: v.object({
    id_token: token,
    access_token: token,
    refresh_token: token,
    account_id: token,
  }),
  last_refresh: v.optional(token),
});

export async function projectCodexAuth(
  bindings: CodexAuthBindings,
  ref: string,
  home: string,
): Promise<void> {
  try {
    if (!Object.hasOwn(bindings, ref)) throw new Error("Unconfigured binding");
    // 只读取被选定文件，丢弃非凭据键；不扫描 home、配置、历史或备用认证来源。
    const login = v.parse(
      loginSchema,
      JSON.parse(await readFile(bindings[ref]!, "utf8")),
    );
    const directory = join(home, ".codex");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "auth.json"), JSON.stringify(login), {
      mode: 0o600,
    });
  } catch {
    // 文件路径、解析原文与 secret 都不得进入错误、日志、wire 或诊断。
    throw workspaceFailure("credential_binding_unavailable");
  }
}
