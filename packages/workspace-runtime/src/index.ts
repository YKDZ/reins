import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import {
  projectConfigurationSchema,
  type WorkspaceError,
  type WorkspaceHarnessCatalog,
} from "@reins/workspace-protocol";
import * as v from "valibot";

import { hasCodexAuthBinding, type CodexAuthBindings } from "./codex-auth.ts";
import { hasQoderAuthBinding, type QoderAuthBindings } from "./qoder-auth.ts";

const execute = promisify(execFile);
export function workspaceFailure(
  code: Exclude<WorkspaceError["code"], "native_view_lost">,
  detail?: string,
): WorkspaceError {
  return { code, ...(detail === undefined ? {} : { detail }) };
}
export async function resolveWorktree(cwd: string) {
  try {
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new Error("Invalid directory");
    const nativeCwd = await realpath(cwd);
    const git = async (flag: string) =>
      (
        await execute("git", [
          "-C",
          nativeCwd,
          "rev-parse",
          "--path-format=absolute",
          flag,
        ])
      ).stdout.trim();
    const root = await realpath(await git("--show-toplevel"));
    const gitDir = await realpath(await git("--git-dir"));
    const commonDir = await realpath(await git("--git-common-dir"));
    return { cwd: nativeCwd, root, gitDir, commonDir };
  } catch {
    throw workspaceFailure("invalid_directory");
  }
}
export function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
async function readConfiguration(cwd: string) {
  const tree = await resolveWorktree(cwd);
  let contents: string;
  try {
    contents = await readFile(
      join(tree.root, ".reins", "workspace.json"),
      "utf8",
    );
  } catch {
    throw workspaceFailure("configuration_missing");
  }
  let input: unknown;
  try {
    input = JSON.parse(contents) as unknown;
  } catch {
    throw workspaceFailure("configuration_invalid");
  }
  const parsed = v.safeParse(projectConfigurationSchema, input);
  if (!parsed.success) throw workspaceFailure("configuration_invalid");
  return parsed.output;
}
function selectEnvironment(
  configuration: v.InferOutput<typeof projectConfigurationSchema>,
) {
  if (configuration.environments.length === 0)
    throw workspaceFailure("environment_binding_missing");
  if (configuration.environments.length !== 1)
    throw workspaceFailure("environment_binding_ambiguous");
  return configuration.environments[0]!;
}
export async function workspaceEnvironment(cwd: string) {
  return selectEnvironment(await readConfiguration(cwd));
}
export async function workspaceHarnesses(
  cwd: string,
  codexAuthBindings: CodexAuthBindings = {},
  qoderAuthBindings: QoderAuthBindings = {},
): Promise<WorkspaceHarnessCatalog> {
  const configuration = await readConfiguration(cwd);
  const environment = selectEnvironment(configuration);
  const refs = new Set<string>();
  const bindings = configuration.bindings.map((binding) => {
    if (refs.has(binding.ref)) throw workspaceFailure("binding_conflict");
    refs.add(binding.ref);
    const definitions = configuration.runtimes.filter(
      (runtime) => runtime.harness === binding.harness,
    );
    if (definitions.length === 0)
      throw workspaceFailure("runtime_definition_missing");
    if (definitions.length !== 1)
      throw workspaceFailure("runtime_definition_ambiguous");
    const runtime = definitions[0]!;
    return {
      ref: binding.ref,
      harness: binding.harness,
      credential:
        binding.credentialBindingRef === undefined
          ? { kind: "omitted" as const }
          : {
              kind: "bound" as const,
              ref: binding.credentialBindingRef,
              label: binding.credentialBindingRef,
            },
      runtime,
      runtimeFingerprint: fingerprint(runtime),
      supportBundle: fingerprint({
        harness: binding.harness,
        runtime,
        provider: environment.provider,
        extensionVersion:
          binding.harness === "codex" && runtime.version === "0.162.0" ? 2 : 1,
      }),
      compatibility:
        binding.credentialBindingRef === undefined ||
        hasCodexAuthBinding(
          codexAuthBindings,
          binding.harness,
          runtime.version,
          binding.credentialBindingRef,
        ) ||
        hasQoderAuthBinding(
          qoderAuthBindings,
          binding.harness,
          runtime.version,
          binding.credentialBindingRef,
        )
          ? ("supported" as const)
          : ("credential_binding_unavailable" as const),
    };
  });
  return {
    environment,
    environmentFingerprint: fingerprint(environment),
    bindings,
  };
}
export { openWorkspaceRuntime, deleteWorkspaceHistory } from "./runtime.ts";
export { parseQoderAuthBindings } from "./qoder-auth.ts";
export { parseCodexAuthBindings } from "./codex-auth.ts";
