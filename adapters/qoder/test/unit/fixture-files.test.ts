import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  assertMatchesKnownCredentialPolicy,
  KnownCredentialPolicyError,
  replaceFixturePair,
} from "../scripts/fixture-files.ts";

const directories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-fixture-files-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function failMetadataInstallOnce(metadataPath: string) {
  let failed = false;
  return async (source: string, destination: string): Promise<void> => {
    if (!failed && source.includes(".tmp") && destination === metadataPath) {
      failed = true;
      throw new Error("injected metadata install failure");
    }
    await rename(source, destination);
  };
}

function failRenameCallOnce(callToFail: number) {
  let calls = 0;
  return async (source: string, destination: string): Promise<void> => {
    calls += 1;
    if (calls === callToFail) {
      throw new Error("injected rename failure");
    }
    await rename(source, destination);
  };
}

function failRenameCalls(callsToFail: ReadonlySet<number>) {
  let calls = 0;
  return async (source: string, destination: string): Promise<void> => {
    calls += 1;
    if (callsToFail.has(calls)) {
      throw new Error(`injected rename failure ${calls}`);
    }
    await rename(source, destination);
  };
}

describe("fixture 文件对替换", () => {
  test("已有文件对在第二个 install 失败后逐字节恢复且无残留", async () => {
    const directory = await fixtureDirectory();
    const jsonlPath = join(directory, "sample.jsonl");
    const metadataPath = join(directory, "sample.metadata.json");
    await writeFile(jsonlPath, "old-jsonl\n");
    await writeFile(metadataPath, "old-metadata\n");

    await expect(
      replaceFixturePair(
        {
          jsonlPath,
          metadataPath,
          jsonl: "new-jsonl\n",
          metadata: "new-metadata\n",
        },
        { renameFile: failMetadataInstallOnce(metadataPath) },
      ),
    ).rejects.toMatchObject({ code: "fixture_pair_replace_failed" });

    await expect(readFile(jsonlPath, "utf8")).resolves.toBe("old-jsonl\n");
    await expect(readFile(metadataPath, "utf8")).resolves.toBe(
      "old-metadata\n",
    );
    await expect(readdir(directory)).resolves.toEqual([
      "sample.jsonl",
      "sample.metadata.json",
    ]);
  });

  test("首次生成在第二个 install 失败后恢复为两个目标都不存在", async () => {
    const directory = await fixtureDirectory();
    const jsonlPath = join(directory, "sample.jsonl");
    const metadataPath = join(directory, "sample.metadata.json");

    await expect(
      replaceFixturePair(
        {
          jsonlPath,
          metadataPath,
          jsonl: "new-jsonl\n",
          metadata: "new-metadata\n",
        },
        { renameFile: failMetadataInstallOnce(metadataPath) },
      ),
    ).rejects.toMatchObject({ code: "fixture_pair_replace_failed" });

    await expect(readdir(directory)).resolves.toEqual([]);
  });

  test.each([1, 2, 3, 4])(
    "已有文件对在第 %i 个 rename 失败后恢复旧 pair",
    async (callToFail) => {
      const directory = await fixtureDirectory();
      const jsonlPath = join(directory, "sample.jsonl");
      const metadataPath = join(directory, "sample.metadata.json");
      await writeFile(jsonlPath, "old-jsonl\n");
      await writeFile(metadataPath, "old-metadata\n");

      await expect(
        replaceFixturePair(
          {
            jsonlPath,
            metadataPath,
            jsonl: "new-jsonl\n",
            metadata: "new-metadata\n",
          },
          { renameFile: failRenameCallOnce(callToFail) },
        ),
      ).rejects.toMatchObject({ code: "fixture_pair_replace_failed" });

      await expect(readFile(jsonlPath, "utf8")).resolves.toBe("old-jsonl\n");
      await expect(readFile(metadataPath, "utf8")).resolves.toBe(
        "old-metadata\n",
      );
      await expect(readdir(directory)).resolves.toEqual([
        "sample.jsonl",
        "sample.metadata.json",
      ]);
    },
  );

  test("成功时两个目标同时更新且无残留", async () => {
    const directory = await fixtureDirectory();
    const jsonlPath = join(directory, "sample.jsonl");
    const metadataPath = join(directory, "sample.metadata.json");
    await writeFile(jsonlPath, "old-jsonl\n");
    await writeFile(metadataPath, "old-metadata\n");

    await replaceFixturePair({
      jsonlPath,
      metadataPath,
      jsonl: "new-jsonl\n",
      metadata: "new-metadata\n",
    });

    await expect(readFile(jsonlPath, "utf8")).resolves.toBe("new-jsonl\n");
    await expect(readFile(metadataPath, "utf8")).resolves.toBe(
      "new-metadata\n",
    );
    await expect(readdir(directory)).resolves.toEqual([
      "sample.jsonl",
      "sample.metadata.json",
    ]);
  });

  test("install 与 rollback 都失败时保留仍是唯一原件的 backup", async () => {
    const directory = await fixtureDirectory();
    const jsonlPath = join(directory, "sample.jsonl");
    const metadataPath = join(directory, "sample.metadata.json");
    await writeFile(jsonlPath, "old-jsonl\n");
    await writeFile(metadataPath, "old-metadata\n");

    await expect(
      replaceFixturePair(
        {
          jsonlPath,
          metadataPath,
          jsonl: "new-jsonl\n",
          metadata: "new-metadata\n",
        },
        { renameFile: failRenameCalls(new Set([4, 6])) },
      ),
    ).rejects.toMatchObject({ code: "fixture_pair_rollback_failed" });

    const files = await readdir(directory);
    const jsonlBackup = files.find(
      (file) => file.startsWith("sample.jsonl.") && file.endsWith(".backup"),
    );
    expect(jsonlBackup).toBeDefined();
    await expect(readFile(join(directory, jsonlBackup!), "utf8")).resolves.toBe(
      "old-jsonl\n",
    );
    await expect(readFile(metadataPath, "utf8")).resolves.toBe(
      "old-metadata\n",
    );
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });
});

describe("known credential policy", () => {
  test.each([
    "password",
    "private_key",
    "client-secret",
    "sessionToken",
    "access_token",
    "refreshToken",
    "api-key",
    "authorization",
    "cookie",
    "secret",
  ])("拒绝规范化敏感 key %s", (key) => {
    expect(() =>
      assertMatchesKnownCredentialPolicy({ [key]: "redacted" }),
    ).toThrow(KnownCredentialPolicyError);
  });

  test.each([
    "Bearer abcdefghijklmnop",
    "sk-abcdefghijklmnop",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "github_pat_abcdefghijklmnopqrstuvwxyz_123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123",
    "-----BEGIN PRIVATE KEY-----\nredacted\n-----END PRIVATE KEY-----",
  ])("拒绝已知 credential 字符串形式", (value) => {
    expect(() => assertMatchesKnownCredentialPolicy({ value })).toThrow(
      KnownCredentialPolicyError,
    );
  });

  test("允许明确无凭据来源与普通 fixture 事实", () => {
    expect(() =>
      assertMatchesKnownCredentialPolicy({
        apiKeySource: "none",
        result: "token count: 3",
        nested: [null, 0, false],
      }),
    ).not.toThrow();
  });

  test.each([
    { auth: { oauth: "opaque-device-secret" } },
    { oauth_token: "opaque-device-secret" },
    { device_token: "opaque-device-secret" },
    { credential: "opaque-device-secret" },
    { "session token": "opaque-device-secret" },
    { runtime: { state: { oauth: "opaque-device-secret" } } },
  ])("拒绝闭合保存契约中的认证与嵌套运行态字段", (candidate) => {
    expect(() => assertMatchesKnownCredentialPolicy(candidate)).toThrow(
      KnownCredentialPolicyError,
    );
  });

  test("apiKeySource 只允许精确的 none sentinel", () => {
    expect(() =>
      assertMatchesKnownCredentialPolicy({ apiKeySource: "environment" }),
    ).toThrow(KnownCredentialPolicyError);
  });
});
