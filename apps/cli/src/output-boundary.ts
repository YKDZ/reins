import { EXIT_OK, EXIT_RESOURCE, outputError } from "./errors.ts";
import { printError } from "./output.ts";

let installed = false;

function systemCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export function installStdoutErrorBoundary(): void {
  if (installed) return;
  installed = true;
  process.stdout.on("error", (error: unknown) => {
    const code = systemCode(error);
    if (code === "EPIPE") process.exit(EXIT_OK);
    printError(outputError(code), "pretty");
    process.exit(EXIT_RESOURCE);
  });
}
