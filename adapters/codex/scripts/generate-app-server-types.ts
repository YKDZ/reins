// 从本机 codex 二进制的 `app-server generate-ts` 生成协议类型（ADR-0018）。
// 只收录本 adapter 消费类型的 import 闭包；升级 codex 后重跑：pnpm codegen:types
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 与 src/mapper.ts、src/codex-driver.ts 的导入保持一致。
const roots = [
  "v2/ThreadItem.ts",
  "v2/TurnStatus.ts",
  "v2/CommandExecutionApprovalDecision.ts",
  "v2/FileChangeApprovalDecision.ts",
  "v2/PermissionGrantScope.ts",
  "v2/GrantedPermissionProfile.ts",
  "v2/UserInput.ts",
  "v2/ModelListResponse.ts",
];
const experimentalRoots = [
  "InitializeCapabilities.ts",
  "v2/ThreadBackgroundTerminalsListParams.ts",
  "v2/ThreadBackgroundTerminalsListResponse.ts",
  "v2/ThreadBackgroundTerminalsTerminateParams.ts",
  "v2/ThreadBackgroundTerminalsTerminateResponse.ts",
];

const output = fileURLToPath(new URL("../src/generated/", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "codex-app-server-types-"));
const experimentalTmp = mkdtempSync(
  join(tmpdir(), "codex-app-server-types-experimental-"),
);
execFileSync("codex", ["app-server", "generate-ts", "--out", tmp], {
  stdio: "inherit",
});
execFileSync(
  "codex",
  ["app-server", "generate-ts", "--experimental", "--out", experimentalTmp],
  { stdio: "inherit" },
);
const version = execFileSync("codex", ["--version"], {
  encoding: "utf8",
}).trim();

function resolveImport(fromFile: string, spec: string): string {
  const parts = fromFile.split("/").slice(0, -1).concat(spec.split("/"));
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "..") normalized.pop();
    else if (part !== ".") normalized.push(part);
  }
  return normalized.join("/");
}

const copied = new Map<string, string>();

function collect(file: string, sourceRoot: string): void {
  if (copied.has(file)) return;
  copied.set(file, sourceRoot);
  const text = readFileSync(join(sourceRoot, file), "utf8");
  for (const match of text.matchAll(/from "(\.[^"]+)"/g)) {
    const spec = match[1];
    if (spec === undefined) continue;
    const resolved = resolveImport(file, spec);
    if (existsSync(join(sourceRoot, `${resolved}.ts`)))
      collect(`${resolved}.ts`, sourceRoot);
    else if (existsSync(join(sourceRoot, resolved, "index.ts"))) {
      collect(join(resolved, "index.ts"), sourceRoot);
    }
  }
}

function rewriteImports(text: string, sourceDir: string): string {
  return text.replace(/from "(\.[^"]*)"/g, (_all, spec: string) => {
    if (existsSync(join(sourceDir, `${spec}.ts`))) return `from "${spec}.ts"`;
    if (existsSync(join(sourceDir, spec, "index.ts"))) {
      return `from "${spec}/index.ts"`;
    }
    return `from "${spec}"`;
  });
}

for (const root of roots) collect(root, tmp);
for (const root of experimentalRoots) collect(root, experimentalTmp);
rmSync(output, { recursive: true, force: true });
for (const [file, sourceRoot] of copied) {
  const sourceDir = join(sourceRoot, file.split("/").slice(0, -1).join("/"));
  const dest = join(output, file);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(
    dest,
    rewriteImports(readFileSync(join(sourceRoot, file), "utf8"), sourceDir),
  );
}
rmSync(tmp, { recursive: true, force: true });
rmSync(experimentalTmp, { recursive: true, force: true });
console.log(
  `Generated ${copied.size} file(s) from ${version} into src/generated/`,
);
