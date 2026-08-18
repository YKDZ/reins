import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const rootOwnedFormatInputs = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.config.json",
  "oxfmt.config.ts",
  "oxlint.config.ts",
  ".gitignore",
  "TODO.md",
  "rust-toolchain.toml",
  ".vscode",
  ".github",
  ".devcontainer",
  "scripts",
] as const;

const rootOwnedLintInputs = [
  "oxfmt.config.ts",
  "oxlint.config.ts",
  "scripts",
] as const;

function existing(inputs: readonly string[]): string[] {
  return inputs.filter((input) => existsSync(input));
}

const task = process.argv[2];
const command =
  task === "format:check"
    ? ["exec", "oxfmt", "--list-different", "--config", "oxfmt.config.ts"]
    : task === "format:write"
      ? ["exec", "oxfmt", "--write", "--config", "oxfmt.config.ts"]
      : task === "lint"
        ? [
            "exec",
            "oxlint",
            "--quiet",
            "--format=unix",
            "--config",
            "oxlint.config.ts",
          ]
        : task === "lint:fix"
          ? [
              "exec",
              "oxlint",
              "--format=unix",
              "--config",
              "oxlint.config.ts",
              "--fix",
            ]
          : undefined;

if (command === undefined) {
  throw new Error(`Unknown root-owned task: ${task ?? "(missing)"}`);
}

const inputs = existing(
  task === "format:check" || task === "format:write"
    ? rootOwnedFormatInputs
    : rootOwnedLintInputs,
);
const result = spawnSync("pnpm", [...command, ...inputs], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
