import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("../task-gates.ts", import.meta.url));
const turbo = fileURLToPath(
  new URL("../../node_modules/.bin/turbo", import.meta.url),
);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reins-task-gates-"));
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
  await symlink(turbo, join(directory, "node_modules", ".bin", "turbo"));
  await copyFile(wrapper, join(directory, "scripts", "task-gates.ts"));
  const scripts: Record<string, string> = {};
  const tasks: Record<
    string,
    { tags: string[]; cache: boolean; dependsOn?: string[] }
  > = {};
  for (const gate of ["check", "check:heavy", "check:full", "fix"]) {
    scripts[gate] = `node --conditions=source scripts/task-gates.ts ${gate}`;
    tasks[`//#${gate}`] = {
      tags: [gate === "fix" ? "work:repair" : "quality:entry"],
      cache: false,
    };
  }
  for (const [name, role] of [
    ["light", "quality:light"],
    ["heavy", "quality:heavy"],
    ["repair", "work:repair"],
  ] as const) {
    scripts[name] =
      `node -e "require('node:fs').appendFileSync('observed', '${name}\\n')"`;
    tasks[`//#${name}`] = { tags: [role], cache: false };
  }
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "task-gate-consumer",
      private: true,
      type: "module",
      packageManager: "pnpm@12.9.1",
      scripts,
    }),
  );
  await mkdir(join(directory, "packages", "leaf"), { recursive: true });
  await writeFile(
    join(directory, "packages", "leaf", "package.json"),
    JSON.stringify({ name: "leaf", private: true }),
  );
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  await writeFile(
    join(directory, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  );
  return {
    directory,
    tasks,
    async execute(gate: string) {
      await writeFile(join(directory, "turbo.json"), JSON.stringify({ tasks }));
      await writeFile(join(directory, "observed"), "");
      const result = spawnSync(
        process.execPath,
        ["--conditions=source", "scripts/task-gates.ts", gate],
        { cwd: directory, encoding: "utf8", timeout: 20_000 },
      );
      return {
        ...result,
        observed: (await readFile(join(directory, "observed"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean),
      };
    },
  };
}

void test("公共入口分别执行轻、重、完整和修复职责", async () => {
  const f = await fixture();
  try {
    for (const [gate, expected] of [
      ["check", ["light"]],
      ["check:heavy", ["heavy"]],
      ["check:full", ["light", "heavy"]],
      ["fix", ["repair"]],
    ] as const) {
      const result = await f.execute(gate);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.observed, expected);
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

void test("缺少或冲突职责在启动任务前失败", async () => {
  const f = await fixture();
  try {
    for (const tags of [[], ["quality:light", "quality:heavy"]]) {
      f.tasks["//#light"]!.tags = tags;
      const result = await f.execute("check");
      assert.equal(result.status, 1);
      assert.deepEqual(result.observed, []);
      assert.match(result.stderr, /唯一职责|多个职责/u);
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

void test("轻验收拒绝越层依赖和公共入口反向依赖", async () => {
  const f = await fixture();
  try {
    for (const dependency of ["//#heavy", "//#check:full"]) {
      f.tasks["//#light"]!.dependsOn = [dependency];
      const result = await f.execute("check");
      assert.equal(result.status, 1);
      assert.deepEqual(result.observed, []);
      assert.match(
        result.stderr,
        /轻检查不能间接启动重验收|叶任务不能依赖公共聚合入口/u,
      );
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
