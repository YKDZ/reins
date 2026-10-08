import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { executeDocker } from "../src/docker.ts";
import type { PlatformOptions } from "../src/types.ts";

const directories: string[] = [];
const options: PlatformOptions = {
  stateDirectory: "/unused",
  bootstrapImage: "unused",
  dockerBinary: process.execPath,
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Docker 客户端执行", () => {
  test("返回真实非零退出状态，并完整保存超出内存摘要的输出", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-docker-process-"));
    directories.push(directory);
    const result = await executeDocker(
      options,
      [
        "-e",
        'process.stdout.write("a".repeat(100000)); process.stderr.write("failure"); process.exitCode = 7;',
      ],
      { outputDirectory: directory },
    );
    expect(result).toMatchObject({
      exitCode: 7,
      signal: null,
      stderr: "failure",
      timedOut: false,
    });
    expect(Buffer.byteLength(result.stdout)).toBe(64 * 1024);
    expect(await readFile(join(directory, "stdout.log"), "utf8")).toBe(
      "a".repeat(100000),
    );
    expect(await readFile(join(directory, "stderr.log"), "utf8")).toBe(
      "failure",
    );
  });

  test("传入标准输入、工作目录与环境", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-docker-input-"));
    directories.push(directory);
    const result = await executeDocker(
      options,
      [
        "-e",
        'process.stdin.on("data", value => process.stdout.write(`${process.cwd()}|${process.env.REINS_TEST_VALUE}|${value}`));',
      ],
      {
        input: "payload",
        cwd: directory,
        env: { ...process.env, REINS_TEST_VALUE: "explicit" },
      },
    );
    expect(result.stdout).toBe(`${directory}|explicit|payload`);
    expect(result.exitCode).toBe(0);
  });

  test("超时等到客户端关闭，保留真实退出信号与已产生的输出", async () => {
    const result = await executeDocker(
      options,
      ["-e", 'process.stdout.write("started"); setInterval(() => {}, 1000);'],
      { timeoutMs: 300 },
    );
    expect(result).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "started",
      timedOut: true,
    });
  });

  test("调用方取消会结束客户端且不冒充超时", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300);
    try {
      const result = await executeDocker(
        options,
        ["-e", "setInterval(() => {}, 1000)"],
        { signal: controller.signal },
      );
      expect(result).toMatchObject({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  test("无法启动命令时拒绝，不返回成功状态", async () => {
    await expect(
      executeDocker(
        { ...options, dockerBinary: "/nonexistent-reins-docker" },
        [],
      ),
    ).rejects.toThrow("ENOENT");
  });
});
