import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export async function bundleWorkspaceClient(input: string, output: string) {
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL(
        "../../../../scripts/bundle-workspace-client.ts",
        import.meta.url,
      ),
    ),
    input,
    output,
  ]);
}
