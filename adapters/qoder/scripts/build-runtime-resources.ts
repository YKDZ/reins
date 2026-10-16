import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageDirectory, "native", "qoder-resource-holder.c");
const outputDirectory = join(packageDirectory, "dist", "native");
const outputPath = join(outputDirectory, "qoder-resource-holder");
const compilerImage =
  "node@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0";
const flags = [
  "-O2",
  "-std=c11",
  "-static",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-D_FORTIFY_SOURCE=2",
  "-fno-ident",
  "-Wl,--build-id=none",
] as const;
const target = "linux-x64";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyExecutable(bytes: Buffer): void {
  if (
    bytes.length < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 62
  ) {
    throw new Error(
      "Qoder resource holder is not an ELF64 Linux x86_64 binary",
    );
  }
}

function compilerArgs(): string[] {
  return [
    "run",
    "--rm",
    "--pull=missing",
    "--network=none",
    "--platform=linux/amd64",
    "--label",
    `codex.qoder-resource-holder-build=${randomUUID()}`,
    "-i",
    "--entrypoint",
    "/bin/sh",
    compilerImage,
    "-eu",
    "-c",
    `cat > /tmp/qoder-resource-holder.c && gcc ${flags.join(" ")} /tmp/qoder-resource-holder.c -o /tmp/qoder-resource-holder && cat /tmp/qoder-resource-holder`,
  ];
}

if (process.platform === "win32") {
  throw new Error("Qoder resource holder builds require a Darwin/Linux host");
}

const source = await readFile(sourcePath);
const result = spawnSync("docker", compilerArgs(), {
  input: source,
  maxBuffer: 8 * 1024 * 1024,
});
if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Qoder holder compilation in ${compilerImage} failed with exit ${result.status ?? 1}\n${result.stderr.toString("utf8")}`,
  );
}

const binary = result.stdout;
verifyExecutable(binary);
await mkdir(outputDirectory, { recursive: true });
const temporaryPath = join(
  outputDirectory,
  `.qoder-resource-holder-${process.pid}.tmp`,
);
try {
  await writeFile(temporaryPath, binary, { mode: 0o755 });
  await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, outputPath);
} finally {
  await rm(temporaryPath, { force: true });
}
const mode = (await stat(outputPath)).mode & 0o777;
if (mode !== 0o755) throw new Error("Qoder resource holder mode is not 0755");
process.stdout.write(
  `${outputPath} (source=${sha256(source)}, compiler=${compilerImage}, flags=${flags.join(" ")}, target=${target})\n`,
);
