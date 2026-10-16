import { accessSync, constants, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const holderFileName = "qoder-resource-holder";

function moduleDirectory(moduleUrl: string): string {
  return fileURLToPath(new URL(".", moduleUrl));
}

export function resolveQoderResourceHolderPath(
  moduleUrl = import.meta.url,
): string {
  const directory = moduleDirectory(moduleUrl);
  const candidates = [
    resolve(directory, "native", holderFileName),
    resolve(directory, "..", "native", holderFileName),
    resolve(directory, "..", "dist", "native", holderFileName),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // source、dist entry 和共享 chunk 的相对目录深度不同。
    }
  }
  throw new Error(
    `Qoder resource holder is missing beside ${dirname(directory)}; rebuild @reins/qoder resources`,
  );
}
