import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test } from "vitest";

import { resolveDaemonCommand } from "../../src/daemon.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  moduleUrl: URL;
  sibling: string;
  development: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "reins-daemon-resolution-"));
  temporaryDirectories.push(root);
  const modulePath = join(root, "apps/cli/dist/daemon.js");
  return {
    moduleUrl: pathToFileURL(modulePath),
    sibling: join(root, "apps/cli/dist/reins-daemon.js"),
    development: join(root, "packages/daemon/dist/main.js"),
  };
}

async function touch(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
}

test("显式 daemon 命令优先于同包与开发产物", async () => {
  const paths = await fixture();
  await Promise.all([touch(paths.sibling), touch(paths.development)]);

  expect(
    resolveDaemonCommand(
      { REINS_DAEMON_BIN: "/fixture/daemon" },
      paths.moduleUrl,
    ),
  ).toEqual(["/fixture/daemon"]);
});

test("发行安装优先使用同包 sibling daemon", async () => {
  const paths = await fixture();
  await Promise.all([touch(paths.sibling), touch(paths.development)]);

  expect(resolveDaemonCommand({}, paths.moduleUrl)).toEqual([
    process.execPath,
    paths.sibling,
  ]);
});

test("源码开发环境回退到 workspace daemon 构建产物", async () => {
  const paths = await fixture();
  await touch(paths.development);

  expect(resolveDaemonCommand({}, paths.moduleUrl)).toEqual([
    process.execPath,
    paths.development,
  ]);
});

test("找不到 daemon 时立即返回类型化错误而不回退 PATH", async () => {
  const paths = await fixture();

  let caught: unknown;
  try {
    resolveDaemonCommand({}, paths.moduleUrl);
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual({
    code: "daemon_start_failed",
    cause: {
      kind: "io",
      message: "Unable to locate the reins-daemon executable",
    },
  });
});
