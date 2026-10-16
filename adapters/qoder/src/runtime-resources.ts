import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { resolveQoderResourceHolderPath } from "./holder-path.ts";

export { resolveQoderResourceHolderPath } from "./holder-path.ts";

export async function copyQoderRuntimeResources(
  distributionDirectory: string,
): Promise<string> {
  const sourcePath = resolveQoderResourceHolderPath(import.meta.url);
  const outputDirectory = join(distributionDirectory, "native");
  const outputPath = join(outputDirectory, "qoder-resource-holder");
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(sourcePath, outputPath);
  await chmod(outputPath, 0o755);
  return outputPath;
}
