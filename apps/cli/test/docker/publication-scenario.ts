import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));

export async function runPublicationScenario(
  observation = false,
  variant?: { ticket: number; client: string; worker: string },
) {
  const ticket = variant?.ticket ?? (observation ? 27 : 26);
  const setting = (name: string) =>
    process.env[`REINS_WRR${variant?.ticket ?? 26}_${name}`];
  const directory = join(
    repository,
    ".artifacts",
    `reins-wrr${ticket}-${randomUUID()}`,
  );
  const input = join(directory, "input");
  await mkdir(input, { recursive: true });
  const registryImage =
    "node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
  const nodeImage = setting("NODE_IMAGE") ?? registryImage;
  // 离线缓存只接受同一已验证 Node 材料的配置摘要，不引入替代镜像。
  expect([
    registryImage,
    "sha256:59c575db86dccc264e6b71c316548f05a5c3c7a9aa1c112dc019807e651fd06b",
  ]).toContain(nodeImage);
  const { version } = JSON.parse(
    await readFile(join(repository, "apps/cli/package.json"), "utf8"),
  ) as { version: string };
  const sources = [
    [
      join(repository, `.artifacts/release/ykdz-reins-${version}.tgz`),
      "candidate.tgz",
    ],
    [
      join(repository, "apps/cli/test/docker/publication-round.ts"),
      "publication-round.ts",
    ],
    [
      join(repository, "apps/cli/test/docker/workspace-reading-adapter.ts"),
      "workspace-reading-adapter.ts",
    ],
  ] as const;
  const fingerprints: { name: string; sha256: string }[] = [];
  await copyFile(
    join(
      repository,
      "apps/cli/test/docker",
      variant?.worker ?? "publishing-worker.ts",
    ),
    join(input, "publishing-worker.ts"),
  );
  fingerprints.push({
    name: "publishing-worker.ts",
    sha256: createHash("sha256")
      .update(await readFile(join(input, "publishing-worker.ts")))
      .digest("hex"),
  });
  execFileSync(process.execPath, [
    join(repository, "scripts/bundle-workspace-client.ts"),
    join(
      repository,
      "apps/cli/test/docker",
      variant?.client ??
        `${observation ? "publication-observation-client" : "publication-client"}.ts`,
    ),
    join(input, "publication-client.js"),
  ]);
  fingerprints.push({
    name: "publication-client.js",
    sha256: createHash("sha256")
      .update(await readFile(join(input, "publication-client.js")))
      .digest("hex"),
  });
  const fixtureBaseImage = setting("FIXTURE_BASE_IMAGE");
  let consumerSha256: string | undefined;
  if (fixtureBaseImage === undefined) {
    const consumer = join(directory, "consumer");
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: {
          "@ykdz/reins":
            "file:" +
            join(repository, `.artifacts/release/ykdz-reins-${version}.tgz`),
        },
      }),
    );
    execFileSync(
      "npm",
      ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: consumer, stdio: "pipe" },
    );
    execFileSync(
      "tar",
      [
        "-cf",
        join(input, "consumer.tar"),
        "package.json",
        "package-lock.json",
        "node_modules",
      ],
      { cwd: consumer },
    );
    consumerSha256 = createHash("sha256")
      .update(await readFile(join(input, "consumer.tar")))
      .digest("hex");
    fingerprints.push({ name: "consumer.tar", sha256: consumerSha256 });
  }
  await writeFile(
    join(input, "base-image.json"),
    JSON.stringify({
      image: nodeImage,
      consumerSha256,
      fixtureBaseImage,
    }),
  );
  fingerprints.push({
    name: "base-image.json",
    sha256: createHash("sha256")
      .update(await readFile(join(input, "base-image.json")))
      .digest("hex"),
  });
  for (const [source, name] of sources) {
    await copyFile(source, join(input, name));
    if (name === "publication-round.ts" && variant !== undefined)
      await writeFile(
        join(input, name),
        (await readFile(source, "utf8")).replaceAll("wrr26", `wrr${ticket}`),
      );
    fingerprints.push({
      name,
      sha256: createHash("sha256")
        .update(await readFile(join(input, name)))
        .digest("hex"),
    });
  }
  // 工具仅来自本机已安装的原生程序；不携带宿主配置、home 或 node_modules。
  const tools = join(input, "tools");
  await mkdir(join(tools, "lib"), { recursive: true });
  const libraries = new Set<string>();
  // 当前 Docker CLI 的 Go 加密后端通过 dlopen 加载，ldd 不会列出它。
  libraries.add("/lib/x86_64-linux-gnu/libcrypto.so.3");
  for (const name of ["git", "docker"]) {
    const executable = execFileSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).trim();
    const native = `tools/${name}-native`;
    await copyFile(executable, join(input, native));
    fingerprints.push({
      name: native,
      sha256: createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
    });
    const dependencies = execFileSync("ldd", [executable], {
      encoding: "utf8",
    });
    for (const match of dependencies.matchAll(/(?:=>\s+|^\s*)(\/\S+)/gmu))
      libraries.add(match[1]!);
    const wrapper = `#!/bin/sh\nlocation=$(dirname "$(readlink -f "$0")")\nexec "$location/lib/ld-linux-x86-64.so.2" --argv0 ${name} --library-path "$location/lib" "$location/${name}-native" "$@"\n`;
    const entry = `tools/${name}`;
    await writeFile(join(input, entry), wrapper, { mode: 0o755 });
    fingerprints.push({
      name: entry,
      sha256: createHash("sha256").update(wrapper).digest("hex"),
    });
  }
  for (const library of libraries) {
    const name = `tools/lib/${basename(library)}`;
    await copyFile(library, join(input, name));
    fingerprints.push({
      name,
      sha256: createHash("sha256")
        .update(await readFile(library))
        .digest("hex"),
    });
  }
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify(fingerprints, null, 2),
  );
  const args = [
    "--conditions=source",
    join(repository, "scripts/run-workspace-test-platform.ts"),
    "run",
    "--state-dir",
    setting("PLATFORM_STATE_DIR") ?? join(directory, "state"),
    ...(setting("PLATFORM_REUSE") === "1" ? ["--reuse"] : []),
    "--evidence-dir",
    join(directory, "evidence"),
    "--image",
    fixtureBaseImage ?? nodeImage,
    "--timeout-ms",
    setting("SCENARIO_TIMEOUT_MS") ?? "3600000",
    ...(setting("PLATFORM_DOCKER_BINARY") === undefined
      ? []
      : ["--docker-binary", setting("PLATFORM_DOCKER_BINARY")!]),
    "--source",
    input,
    "--docker-access",
    "--log-path",
    "evidence",
    "--",
    "node",
    "publication-round.ts",
  ];
  await writeFile(
    join(directory, "command.json"),
    JSON.stringify({ executable: process.execPath, args }, null, 2),
  );
  const result = await new Promise<{
    status: number;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repository,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (status) =>
      resolve({ status: status ?? 1, stdout, stderr }),
    );
  });
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  expect(result.status, `${directory}\n${result.stderr}`).toBe(0);
  const envelope = JSON.parse(result.stdout) as {
    data: { verification: Record<string, string> };
  };
  expect(envelope.data.verification).toEqual({
    scenarioExecution: "passed",
    scenarioCleanup: "passed",
    evidenceExport: "passed",
    platformReclaim: setting("PLATFORM_REUSE") === "1" ? "not_run" : "passed",
  });
}
