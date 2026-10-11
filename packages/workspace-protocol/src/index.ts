import {
  consumerContextSchema,
  sessionIdSchema,
  machineErrorSchema,
  protocolMethodSchema,
  type ProtocolMethod,
  commandIdSchema,
  type CommandId,
} from "@reins/protocol";
import * as v from "valibot";

export const WORKSPACE_PROTOCOL_MAJOR_VERSION = 1;
export const pinnedImageSchema = v.pipe(
  v.string(),
  v.regex(/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/u),
);
export const harnessSchema = v.picklist(["codex", "qoder"]);
export const environmentDefinitionSchema = v.strictObject({
  provider: v.literal("docker"),
  image: pinnedImageSchema,
});
export const runtimeDefinitionSchema = v.strictObject({
  harness: harnessSchema,
  version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/u)),
  image: pinnedImageSchema,
});
export const harnessBindingSchema = v.strictObject({
  ref: v.pipe(v.string(), v.minLength(1)),
  harness: harnessSchema,
  credentialBindingRef: v.optional(v.pipe(v.string(), v.minLength(1))),
});
export const projectConfigurationSchema = v.strictObject({
  environments: v.array(environmentDefinitionSchema),
  runtimes: v.array(runtimeDefinitionSchema),
  bindings: v.array(harnessBindingSchema),
});
export type ProjectConfiguration = v.InferOutput<
  typeof projectConfigurationSchema
>;
export type EnvironmentDefinition = v.InferOutput<
  typeof environmentDefinitionSchema
>;
export type RuntimeDefinition = v.InferOutput<typeof runtimeDefinitionSchema>;
export type HarnessBinding = v.InferOutput<typeof harnessBindingSchema>;
const ordinaryWorkspaceErrorSchema = v.strictObject({
  code: v.picklist([
    "consumer_context_required",
    "consumer_context_conflict",
    "initialization_required",
    "protocol_version_mismatch",
    "invalid_request",
    "invalid_directory",
    "configuration_missing",
    "configuration_invalid",
    "environment_binding_missing",
    "environment_binding_ambiguous",
    "runtime_definition_missing",
    "runtime_definition_ambiguous",
    "binding_unknown",
    "binding_conflict",
    "attachment_owned",
    "attachment_intent_conflict",
    "attachment_not_found",
    "native_view_mismatch",
    "material_unavailable",
    "material_digest_mismatch",
    "capacity_exhausted",
    "runtime_entry_invalid",
    "credential_binding_unavailable",
    "provider_failed",
    "preparation_interrupted",
    "preparation_outcome_unknown",
    "runtime_resource_mismatch",
    "workspace_busy",
    "workspace_detaching",
    "workspace_not_ready",
    "harness_not_prepared",
    "manager_disconnected",
    "manager_timeout",
    "invalid_manager_response",
  ]),
  detail: v.optional(v.string()),
  availableBindings: v.optional(v.array(v.string())),
});
export const nativeViewLossSchema = v.variant("reason", [
  v.strictObject({
    reason: v.literal("moved"),
    currentRoot: v.string(),
  }),
  v.strictObject({ reason: v.literal("replaced") }),
  v.strictObject({ reason: v.literal("removed") }),
  v.strictObject({ reason: v.literal("split") }),
  v.strictObject({ reason: v.literal("unreachable") }),
]);
export type NativeViewLoss = v.InferOutput<typeof nativeViewLossSchema>;
export const workspaceErrorSchema = v.union([
  ordinaryWorkspaceErrorSchema,
  v.strictObject({
    code: v.literal("native_view_lost"),
    detail: v.optional(v.string()),
    nativeView: nativeViewLossSchema,
  }),
]);
export type WorkspaceError = v.InferOutput<typeof workspaceErrorSchema>;
const sessionStopSchema = v.variant("outcome", [
  v.strictObject({
    sessionId: sessionIdSchema,
    outcome: v.literal("confirmed"),
  }),
  v.strictObject({
    sessionId: sessionIdSchema,
    outcome: v.picklist(["unknown", "rejected"]),
    error: v.optional(machineErrorSchema),
  }),
]);
export const nativeViewTerminationSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("stopping"),
    sessions: v.array(sessionStopSchema),
  }),
  v.strictObject({
    status: v.literal("stopped"),
    via: v.literal("harness"),
    sessions: v.array(sessionStopSchema),
  }),
  v.strictObject({
    status: v.literal("unknown"),
    sessions: v.array(sessionStopSchema),
    error: v.optional(machineErrorSchema),
  }),
]);
export type NativeViewTermination = v.InferOutput<
  typeof nativeViewTerminationSchema
>;
export const catalogSchema = v.strictObject({
  environment: environmentDefinitionSchema,
  environmentFingerprint: v.string(),
  bindings: v.array(
    v.strictObject({
      ref: v.string(),
      harness: harnessSchema,
      credential: v.variant("kind", [
        v.strictObject({ kind: v.literal("omitted") }),
        v.strictObject({
          kind: v.literal("bound"),
          ref: v.string(),
          label: v.string(),
        }),
      ]),
      runtime: runtimeDefinitionSchema,
      runtimeFingerprint: v.string(),
      supportBundle: v.string(),
      compatibility: v.picklist([
        "supported",
        "credential_binding_unavailable",
      ]),
    }),
  ),
});
export type WorkspaceHarnessCatalog = v.InferOutput<typeof catalogSchema>;
export const preparationSchema = v.strictObject({
  cwd: v.string(),
  root: v.string(),
  source: v.strictObject({
    status: v.picklist(["pending", "verified", "failed"]),
    error: v.optional(workspaceErrorSchema),
    termination: v.optional(nativeViewTerminationSchema),
  }),
  runtime: v.strictObject({
    status: v.picklist(["preparing", "ready", "failed", "released"]),
    error: v.optional(workspaceErrorSchema),
  }),
  harnesses: v.array(
    v.strictObject({
      ref: v.string(),
      harness: harnessSchema,
      runtime: runtimeDefinitionSchema,
      runtimeFingerprint: v.string(),
      supportBundle: v.string(),
      credential: v.variant("kind", [
        v.strictObject({ kind: v.literal("omitted") }),
        v.strictObject({
          kind: v.literal("bound"),
          ref: v.string(),
          label: v.string(),
        }),
      ]),
      stage: v.picklist([
        "pending",
        "runtime_install",
        "runtime_validate",
        "credential_binding",
        "ready",
        "failed",
      ]),
      error: v.optional(workspaceErrorSchema),
    }),
  ),
  environment: environmentDefinitionSchema,
  environmentFingerprint: v.string(),
  definition: v.optional(
    v.variant("status", [
      v.strictObject({
        status: v.picklist(["unchanged", "drifted"]),
        attached: environmentDefinitionSchema,
        current: environmentDefinitionSchema,
      }),
      v.strictObject({
        status: v.literal("unavailable"),
        attached: environmentDefinitionSchema,
        error: workspaceErrorSchema,
      }),
    ]),
  ),
  history: v.strictObject({ status: v.literal("unavailable") }),
  preparation: v.strictObject({
    attempts: v.array(
      v.strictObject({
        status: v.picklist(["preparing", "ready", "failed"]),
        error: v.optional(workspaceErrorSchema),
      }),
    ),
  }),
});
export type ManagedWorkspaceInfo = v.InferOutput<typeof preparationSchema>;
export const workspaceMethods = [
  "initialize",
  "workspace.harnesses",
  "workspace.attach",
  "workspace.status",
  "workspace.detach",
  "workspace.route",
  "workspace.admit",
] as const;
export type WorkspaceMethod = (typeof workspaceMethods)[number];
export type WorkspaceParams = {
  initialize: {
    protocolMajorVersion: number;
    consumerContext: v.InferOutput<typeof consumerContextSchema>;
  };
  "workspace.harnesses": { cwd: string };
  "workspace.attach": { cwd: string; bindings: string[] };
  "workspace.status": { cwd: string };
  "workspace.route": { cwd: string };
  "workspace.admit": {
    cwd: string;
    action: ProtocolMethod;
    params: unknown;
    commandId?: CommandId;
  };
  "workspace.detach": { cwd: string; sessionDisposition: "require_none" };
};
export type WorkspaceResults = {
  initialize: { protocolMajorVersion: number };
  "workspace.harnesses": WorkspaceHarnessCatalog;
  "workspace.attach": ManagedWorkspaceInfo;
  "workspace.status": ManagedWorkspaceInfo;
  "workspace.route": { cwd: string; socket: string };
  "workspace.admit": { cwd: string };
  "workspace.detach": ManagedWorkspaceInfo;
};
const pathParamsSchema = v.strictObject({ cwd: v.string() });
export const workspaceRequestSchema = v.variant("method", [
  v.strictObject({
    kind: v.literal("request"),
    requestId: v.string(),
    method: v.literal("workspace.route"),
    params: pathParamsSchema,
  }),
  v.strictObject({
    kind: v.literal("request"),
    requestId: v.string(),
    method: v.literal("workspace.admit"),
    params: v.strictObject({
      cwd: v.string(),
      action: protocolMethodSchema,
      params: v.unknown(),
      commandId: v.optional(commandIdSchema),
    }),
  }),
  v.strictObject({
    kind: v.literal("request"),
    requestId: v.string(),
    method: v.literal("initialize"),
    params: v.strictObject({
      protocolMajorVersion: v.number(),
      consumerContext: consumerContextSchema,
    }),
  }),
  v.strictObject({
    kind: v.literal("request"),
    requestId: v.string(),
    method: v.literal("workspace.harnesses"),
    params: v.strictObject({ cwd: v.string() }),
  }),
  v.strictObject({
    kind: v.literal("request"),
    requestId: v.string(),
    method: v.literal("workspace.attach"),
    params: v.strictObject({
      cwd: v.string(),
      bindings: v.pipe(v.array(v.string()), v.minLength(1)),
    }),
  }),
  v.strictObject({
    kind: v.literal("request"),
    requestId: v.string(),
    method: v.literal("workspace.status"),
    params: pathParamsSchema,
  }),
  v.strictObject({
    kind: v.literal("request"),
    requestId: v.string(),
    method: v.literal("workspace.detach"),
    params: v.strictObject({
      cwd: v.string(),
      sessionDisposition: v.literal("require_none"),
    }),
  }),
]);
export type WorkspaceRequest = v.InferOutput<typeof workspaceRequestSchema>;
export const workspaceResponseSchema = v.union([
  v.strictObject({
    kind: v.literal("response"),
    requestId: v.string(),
    result: v.unknown(),
  }),
  v.strictObject({
    kind: v.literal("response"),
    requestId: v.string(),
    error: workspaceErrorSchema,
  }),
]);
export type WorkspaceResponse = v.InferOutput<typeof workspaceResponseSchema>;
export type WorkspaceMessage = WorkspaceRequest | WorkspaceResponse;
export function workspaceResultSchemaFor(method: WorkspaceMethod) {
  return method === "initialize"
    ? v.strictObject({
        protocolMajorVersion: v.literal(WORKSPACE_PROTOCOL_MAJOR_VERSION),
      })
    : method === "workspace.route"
      ? v.strictObject({ cwd: v.string(), socket: v.string() })
      : method === "workspace.admit"
        ? v.strictObject({ cwd: v.string() })
        : method === "workspace.harnesses"
          ? catalogSchema
          : preparationSchema;
}
