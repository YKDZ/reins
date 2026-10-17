import {
  CliWriteError,
  defineCli,
  executeCli,
  helpCapability,
  outputCapability,
  parseCliInvocation,
  versionCapability,
  text,
  type OutputFormat,
  type WriteCliOutput,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe } from "@ykdz/cli-contract/node";
import {
  ReinsSdkError,
  createPresentationProjector,
  type CapabilitiesResult,
  type InterruptResult,
  type DiagnosticId,
  type DiagnosticsQuery,
  type DiagnosticsResult,
  type OperationCredential,
  type OperationKind,
  type SendInput,
  type SendResult,
  type SpawnInput,
  type AgentFact,
  type AgentPresentation,
  type AgentSubscriptionEstablishment,
  type AgentSubscriptionEnd,
  type ReinsConnection,
  type SessionFilter,
  type SessionInfo,
  type SessionHandle,
  type PermissionHandle,
  type PermissionOption,
  type PermissionResolution,
  type TurnHandle,
  type WaitResult,
  type ResumeCursor,
} from "@ykdz/reins-sdk";
import * as v from "valibot";

import { harnessFailureMessage } from "./harness-failure.ts";
import { standardSchema } from "./standard-schema.ts";

export type ReinsCliDependencies = {
  readonly connect: () => Promise<ReinsConnection>;
  readonly outputFormat: OutputFormat;
  readonly cancelOutput: () => void;
  readonly readLine: (
    prompt: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
};

type ReinsCliRuntimeDependencies = Pick<
  ReinsCliDependencies,
  "connect" | "readLine"
>;

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly version: string;
  readonly write: WriteCliOutput;
  readonly cancelOutput: () => void;
  readonly dependencies: ReinsCliRuntimeDependencies;
};

const define = defineCli<ReinsCliDependencies>();

const harnessFailureSchema = v.strictObject({
  failureCategory: v.picklist([
    "credential_rejected",
    "quota_exhausted",
    "balance_exhausted",
    "account_unavailable",
    "rate_limited",
    "model_unavailable",
    "request_rejected",
    "provider_unavailable",
    "runtime_unavailable",
    "unclassified",
  ]),
  retryDisposition: v.picklist([
    "wait",
    "external_state_change",
    "input_change",
    "unknown",
  ]),
});

const capabilityModelSchema = v.strictObject({
  id: v.string(),
  displayName: v.string(),
  reasoningEfforts: v.array(v.string()),
});

const harnessCapabilitySchema = v.strictObject({
  harness: v.string(),
  models: v.array(capabilityModelSchema),
});

const capabilityFailureSchema = v.strictObject({
  harness: v.string(),
  failure: harnessFailureSchema,
  message: v.string(),
  diagnosticId: v.optional(v.string()),
});

const capabilitiesResultSchema = v.strictObject({
  capabilities: v.array(harnessCapabilitySchema),
  failures: v.array(capabilityFailureSchema),
});

const lastCompletedTurnSchema = v.strictObject({
  turnHandle: v.string(),
  stopReason: v.picklist(["end_turn", "cancelled", "failed", "killed"]),
});

const sessionInfoFields = {
  sessionHandle: v.string(),
  sessionName: v.string(),
  harness: v.string(),
  model: v.nullable(v.string()),
  reasoning: v.nullable(v.string()),
  cwd: v.string(),
  spawnedAt: v.string(),
  turns: v.number(),
};

const sessionInfoSchema = v.union([
  v.strictObject({
    ...sessionInfoFields,
    state: v.literal("busy"),
    activeTurn: v.string(),
    lastCompletedTurn: v.optional(lastCompletedTurnSchema),
  }),
  v.strictObject({
    ...sessionInfoFields,
    state: v.literal("idle"),
    lastCompletedTurn: lastCompletedTurnSchema,
  }),
  v.strictObject({
    ...sessionInfoFields,
    state: v.literal("killed"),
    lastCompletedTurn: v.optional(lastCompletedTurnSchema),
  }),
]);

const sessionListSchema = v.strictObject({
  sessions: v.array(sessionInfoSchema),
});

const preparedOperationSchema = v.strictObject({
  operation: v.picklist([
    "spawn",
    "send",
    "interrupt",
    "kill",
    "resolve-permission",
  ]),
  credential: v.string(),
});
const spawnResultSchema = v.strictObject({
  sessionHandle: v.string(),
  turnHandle: v.string(),
  cwd: v.string(),
});
const killResultSchema = v.strictObject({
  sessionHandle: v.string(),
  status: v.picklist(["killed", "not_found"]),
});
const sendResultSchema = v.strictObject({
  sessionHandle: v.string(),
  turnHandle: v.string(),
});
const waitCompletedFields = {
  turnHandle: v.string(),
  finalReply: v.nullable(v.string()),
  usage: v.optional(v.record(v.string(), v.unknown())),
  diagnosticId: v.optional(v.string()),
};
const waitCompletedSchema = v.union([
  v.strictObject({
    ...waitCompletedFields,
    stopReason: v.literal("failed"),
    failure: harnessFailureSchema,
    message: v.string(),
  }),
  v.strictObject({
    ...waitCompletedFields,
    stopReason: v.picklist(["end_turn", "cancelled", "killed"]),
  }),
]);
const waitResultSchema = v.strictObject({
  status: v.picklist(["satisfied", "timeout"]),
  completed: v.array(waitCompletedSchema),
  pending: v.array(v.strictObject({ turnHandle: v.string() })),
});
const interruptResultSchema = v.strictObject({
  turnHandle: v.string(),
  status: v.literal("accepted"),
});

const sdkFailureSchema = v.strictObject({
  code: v.string(),
  facts: v.record(v.string(), v.unknown()),
});

const diagnosticsRecordSchema = v.record(v.string(), v.unknown());
const diagnosticsResultSchema = v.union([
  v.strictObject({ record: diagnosticsRecordSchema }),
  v.strictObject({
    records: v.array(diagnosticsRecordSchema),
    truncated: v.boolean(),
  }),
]);

const permissionResolutionInputSchema = standardSchema(
  v.strictObject({
    permission: v.string(),
    operation: v.string(),
    outcome: v.picklist(["allow", "deny"]),
    scope: v.optional(v.picklist(["once", "session"])),
    feedback: v.optional(v.string()),
  }),
);

const preparedPermissionResolutionSchema = v.strictObject({
  permissionHandle: v.string(),
  credential: v.string(),
  resolution: v.union([
    v.strictObject({
      outcome: v.literal("allow"),
      scope: v.picklist(["once", "session"]),
    }),
    v.strictObject({
      outcome: v.literal("deny"),
      feedback: v.optional(v.string()),
    }),
  ]),
});

const diagnosticsInputSchema = standardSchema(
  v.pipe(
    v.strictObject({
      id: v.optional(v.string()),
      session: v.optional(v.string()),
      turn: v.optional(v.string()),
      harness: v.optional(v.string()),
      source: v.optional(
        v.array(v.picklist(["daemon", "core", "adapter", "harness"])),
      ),
      kind: v.optional(
        v.array(
          v.picklist([
            "lifecycle",
            "mapping_gap",
            "compatibility_gap",
            "request_failure",
            "stream_failure",
            "turn_failure",
            "authorization_failure",
            "protocol_violation",
            "transport_failure",
            "storage_failure",
            "harness_stderr",
          ]),
        ),
      ),
      minSeverity: v.optional(
        v.picklist(["debug", "info", "warning", "error"]),
      ),
      since: v.optional(v.string()),
      until: v.optional(v.string()),
      limit: v.optional(v.string()),
    }),
    v.check(({ since, until, limit }) => {
      return (
        (since === undefined || until === undefined || since <= until) &&
        (limit === undefined ||
          (/^\d+$/u.test(limit) && Number(limit) >= 1 && Number(limit) <= 1000))
      );
    }),
  ),
  ["check"],
);

const emptyInput = standardSchema(v.object({}));

const attachEstablishmentSchema = v.strictObject({
  target: v.unknown(),
  window: v.strictObject({
    oldest: v.nullable(v.number()),
    head: v.nullable(v.number()),
    truncated: v.boolean(),
  }),
  replayed: v.number(),
});

const attachEndSchema = v.strictObject({
  target: v.unknown(),
  reason: v.picklist([
    "end_turn",
    "cancelled",
    "failed",
    "killed",
    "session_killed",
    "closed",
  ]),
});

const attachFactSchema = v.looseObject({
  factId: v.string(),
  sessionHandle: v.string(),
  type: v.string(),
});

const attachPresentationSchema = v.looseObject({ type: v.string() });

const attachInputSchema = standardSchema(
  v.strictObject({
    target: v.string(),
    scope: v.picklist(["session", "turn"]),
    replay: v.optional(v.picklist(["none", "available", "after"])),
    cursor: v.optional(v.string()),
  }),
);

function createCli(version: string) {
  return define({
    root: "reins",
    help: helpCapability({
      shortAlias: "-h",
      headings: {
        usage: "Usage",
        commands: "Commands",
        arguments: "Arguments",
        options: "Options",
        constraints: "Constraints",
      },
      wording: {
        commandPlaceholder: "command",
        choices: "Choices: {choices}",
        default: "Default: {value}",
        whenOnMatch: "When {facts}, {onMatch}",
        whenOnMatchOtherwise: "When {facts}, {onMatch}; otherwise, {otherwise}",
        require: "require {fields}",
        forbid: "forbid {fields}",
        present: "{field} is provided",
        equals: "{field} equals {value}",
      },
    }),
    version: versionCapability({
      value: text.line(`reins ${version}`),
      shortAlias: "-V",
    }),
    output: outputCapability({ defaultFormat: "structured", text: true }),
    usageFailureExitCode: 64,
    commands: {
      reins: {
        kind: "rootGroup",
        name: "reins",
        description: "Query the Reins Harness control plane.",
      },
      ...define.command("capabilities")({
        kind: "command",
        parent: "reins",
        name: "capabilities",
        description: "Query runtime Harness capabilities.",
        fields: {},
        input: emptyInput,
        success: {
          kind: "data",
          variants: {
            result: {
              description: "Current capability matrix",
              exitCode: 0,
              schema: standardSchema(capabilitiesResultSchema),
              text: (result) => text.line(JSON.stringify(result)),
            },
          },
        },
        failures: {
          queryFailed: {
            description: "The Reins query failed",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) => text.line(`Query failed: ${failure.code}`),
          },
        },
        async handler({ dependencies, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const result: CapabilitiesResult = await connection.capabilities();
            return outcome.data.result({
              capabilities: result.capabilities,
              failures: result.failures.map(
                ({ harness, diagnosticId, ...failure }) => ({
                  harness,
                  failure,
                  ...(diagnosticId === undefined ? {} : { diagnosticId }),
                  message: harnessFailureMessage(
                    failure,
                    diagnosticId as Parameters<typeof harnessFailureMessage>[1],
                  ),
                }),
              ),
            });
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.queryFailed({ failure: error.failure });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("prepareOperation")({
        kind: "command",
        parent: "reins",
        name: "prepare-operation",
        description:
          "Create a serializable credential before a control operation.",
        fields: {
          operation: {
            kind: "positional",
            description:
              "Operation to prepare: spawn, send, interrupt, kill, or resolve-permission.",
          },
        },
        input: standardSchema(
          v.object({
            operation: v.picklist([
              "spawn",
              "send",
              "interrupt",
              "kill",
              "resolve-permission",
            ]),
          }),
        ),
        success: {
          kind: "data",
          variants: {
            result: {
              description: "Prepared operation credential",
              exitCode: 0,
              schema: standardSchema(preparedOperationSchema),
              text: ({ credential }) => text.line(credential),
            },
          },
        },
        failures: {
          operationFailed: {
            description: "The operation credential could not be prepared",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) =>
              text.line(`Operation preparation failed: ${failure.code}`),
          },
        },
        async handler({ dependencies, input, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const operation =
              input.operation === "resolve-permission"
                ? "resolvePermission"
                : input.operation;
            const credential: OperationCredential<OperationKind> =
              connection.prepareOperation(operation);
            return outcome.data.result({
              operation: input.operation,
              credential,
            });
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.operationFailed({
                failure: error.failure,
              });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("spawn")({
        kind: "command",
        parent: "reins",
        name: "spawn",
        description: "Start a session using a prepared operation credential.",
        fields: {
          operation: {
            kind: "valueOption",
            longOption: "--operation",
            description: "Credential returned by prepare-operation spawn.",
          },
          name: {
            kind: "valueOption",
            longOption: "--name",
            description: "Session name.",
          },
          harness: {
            kind: "valueOption",
            longOption: "--harness",
            description: "Runtime Harness id.",
          },
          message: {
            kind: "valueOption",
            longOption: "--message",
            description: "Original task text for the new session.",
          },
          cwd: {
            kind: "valueOption",
            longOption: "--cwd",
            description:
              "Absolute working directory in the daemon environment.",
          },
          agent: {
            kind: "valueOption",
            longOption: "--agent",
            description: "Explicit Harness agent.",
          },
          model: {
            kind: "valueOption",
            longOption: "--model",
            description: "Explicit model id.",
          },
          reasoning: {
            kind: "valueOption",
            longOption: "--reasoning",
            description: "Explicit reasoning effort.",
          },
          authorizationMode: {
            kind: "valueOption",
            longOption: "--authorization-mode",
            description: "Explicit authorization mode.",
          },
          sandbox: {
            kind: "valueOption",
            longOption: "--sandbox",
            description: "Explicit Harness sandbox.",
          },
          captureHarnessStderr: {
            kind: "flag",
            longOption: "--capture-harness-stderr",
            description: "Capture Harness stderr when supported.",
          },
        },
        input: standardSchema(
          v.object({
            operation: v.string(),
            name: v.string(),
            harness: v.string(),
            message: v.string(),
            cwd: v.string(),
            agent: v.optional(v.string()),
            model: v.optional(v.string()),
            reasoning: v.optional(v.string()),
            authorizationMode: v.optional(
              v.picklist(["interactive", "allowAll"]),
            ),
            sandbox: v.optional(v.string()),
            captureHarnessStderr: v.optional(v.boolean()),
          }),
        ),
        success: {
          kind: "data",
          variants: {
            result: {
              description: "Started session and active turn handles",
              exitCode: 0,
              schema: standardSchema(spawnResultSchema),
              text: ({ sessionHandle, turnHandle }) =>
                text.line(`Started ${sessionHandle} at ${turnHandle}`),
            },
          },
        },
        failures: {
          operationFailed: {
            description: "The session could not be started or recovered",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) => text.line(`Spawn failed: ${failure.code}`),
          },
        },
        async handler({ dependencies, input, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const spawnInput: SpawnInput = {
              sessionName: input.name,
              harness: input.harness,
              message: input.message,
              cwd: input.cwd,
              ...(input.agent === undefined ? {} : { agent: input.agent }),
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.reasoning === undefined
                ? {}
                : { reasoning: input.reasoning }),
              ...(input.authorizationMode === undefined
                ? {}
                : { authorizationMode: input.authorizationMode }),
              ...(input.sandbox === undefined
                ? {}
                : { sandbox: input.sandbox }),
              ...(input.captureHarnessStderr === undefined
                ? {}
                : { captureHarnessStderr: input.captureHarnessStderr }),
            };
            const result = await connection.spawn(
              spawnInput,
              input.operation as OperationCredential<"spawn">,
            );
            return outcome.data.result(result);
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.operationFailed({
                failure: error.failure,
              });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("list")({
        kind: "command",
        parent: "reins",
        name: "list",
        description: "List Reins sessions and their current state.",
        fields: {
          session: {
            kind: "valueOption",
            longOption: "--session",
            description: "Filter by an exact session handle.",
          },
          harness: {
            kind: "valueOption",
            longOption: "--harness",
            description: "Filter by a runtime Harness id.",
          },
          state: {
            kind: "valueOption",
            longOption: "--state",
            description: "Filter by current session state.",
          },
          name: {
            kind: "valueOption",
            longOption: "--name",
            description: "Filter by session name.",
          },
          model: {
            kind: "valueOption",
            longOption: "--model",
            description: "Filter by model id.",
          },
        },
        input: standardSchema(
          v.object({
            session: v.optional(v.string()),
            harness: v.optional(v.string()),
            state: v.optional(v.picklist(["busy", "idle", "killed"])),
            name: v.optional(v.string()),
            model: v.optional(v.string()),
          }),
        ),
        success: {
          kind: "data",
          variants: {
            result: {
              description: "Matching sessions",
              exitCode: 0,
              schema: standardSchema(sessionListSchema),
              text: ({ sessions }) =>
                text.line(
                  sessions.length === 0
                    ? "No sessions found"
                    : sessions
                        .map(
                          (session) =>
                            `${session.sessionHandle}\t${session.harness}\t${session.state}\t${session.model ?? "-"}`,
                        )
                        .join("\n"),
                ),
            },
          },
        },
        failures: {
          queryFailed: {
            description: "The Reins query failed",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) => text.line(`Query failed: ${failure.code}`),
          },
        },
        async handler({ dependencies, input, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const filter: SessionFilter = {
              ...(input.session === undefined
                ? {}
                : { sessionHandle: input.session as SessionHandle }),
              ...(input.harness === undefined
                ? {}
                : { harness: input.harness }),
              ...(input.state === undefined ? {} : { state: input.state }),
              ...(input.name === undefined ? {} : { sessionName: input.name }),
              ...(input.model === undefined ? {} : { model: input.model }),
            };
            const sessions: SessionInfo[] = await connection.list(filter);
            return outcome.data.result({ sessions });
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.queryFailed({ failure: error.failure });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("kill")({
        kind: "command",
        parent: "reins",
        name: "kill",
        description: "Stop a session using a prepared operation credential.",
        fields: {
          session: {
            kind: "valueOption",
            longOption: "--session",
            description: "Exact session handle to stop.",
          },
          operation: {
            kind: "valueOption",
            longOption: "--operation",
            description: "Credential returned by prepare-operation kill.",
          },
        },
        input: standardSchema(
          v.object({ session: v.string(), operation: v.string() }),
        ),
        success: {
          kind: "data",
          variants: {
            result: {
              description: "Session cleanup result",
              exitCode: 0,
              schema: standardSchema(killResultSchema),
              text: ({ sessionHandle, status }) =>
                text.line(`${sessionHandle}: ${status}`),
            },
          },
        },
        failures: {
          operationFailed: {
            description: "The session could not be stopped or recovered",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) => text.line(`Kill failed: ${failure.code}`),
          },
        },
        async handler({ dependencies, input, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const result = await connection.kill(
              { sessionHandle: input.session as SessionHandle },
              input.operation as OperationCredential<"kill">,
            );
            return outcome.data.result(result);
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.operationFailed({
                failure: error.failure,
              });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("send")({
        kind: "command",
        parent: "reins",
        name: "send",
        description: "Send a message to an explicitly selected turn.",
        fields: {
          target: {
            kind: "positional",
            description:
              "Session handle for new_turn or turn handle for active_turn.",
          },
          placement: {
            kind: "valueOption",
            longOption: "--placement",
            description: "Explicitly choose active_turn or new_turn.",
          },
          message: {
            kind: "valueOption",
            longOption: "--message",
            description: "The exact message text to deliver.",
          },
          operation: {
            kind: "valueOption",
            longOption: "--operation",
            description: "Credential returned by prepare-operation send.",
          },
        },
        input: standardSchema(
          v.object({
            target: v.string(),
            placement: v.picklist(["active_turn", "new_turn"]),
            message: v.string(),
            operation: v.string(),
          }),
        ),
        success: {
          kind: "data",
          variants: {
            result: {
              description: "The exact turn that accepted the message.",
              exitCode: 0,
              schema: standardSchema(sendResultSchema),
              text: ({ turnHandle }) =>
                text.line(`Message delivered to ${turnHandle}`),
            },
          },
        },
        failures: {
          operationFailed: {
            description: "The message could not be delivered or recovered.",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) => text.line(`Send failed: ${failure.code}`),
          },
        },
        async handler({ dependencies, input, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const sendInput: SendInput =
              input.placement === "active_turn"
                ? {
                    placement: "active_turn",
                    turnHandle: input.target as TurnHandle,
                    message: input.message,
                  }
                : {
                    placement: "new_turn",
                    sessionHandle: input.target as SessionHandle,
                    message: input.message,
                  };
            const result: SendResult = await connection.send(
              sendInput,
              input.operation as OperationCredential<"send">,
            );
            return outcome.data.result({
              sessionHandle: result.sessionHandle,
              turnHandle: result.turnHandle,
            });
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.operationFailed({
                failure: error.failure,
              });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("wait")({
        kind: "command",
        parent: "reins",
        name: "wait",
        description:
          "Wait for an exact set of turns using any or all completion.",
        fields: {
          targets: {
            kind: "variadicPositional",
            description: "One or more exact turn handles.",
          },
          completion: {
            kind: "valueOption",
            longOption: "--completion",
            description: "Return when any or all targets are complete.",
          },
          timeout: {
            kind: "valueOption",
            longOption: "--timeout",
            description:
              "Observation budget in milliseconds; omitted waits indefinitely.",
          },
        },
        input: standardSchema(
          v.object({
            targets: v.array(v.string()),
            completion: v.picklist(["any", "all"]),
            timeout: v.optional(
              v.pipe(
                v.string(),
                v.check(
                  (value) =>
                    Number.isFinite(Number(value)) && Number(value) >= 0,
                ),
              ),
            ),
          }),
          ["check"],
        ),
        success: {
          kind: "data",
          variants: {
            completed: {
              description: "All requested turns completed.",
              exitCode: 0,
              schema: standardSchema(
                v.strictObject({ result: waitResultSchema }),
              ),
              text: ({ result }) => renderWaitText(result),
            },
            failed: {
              description: "A turn completed with a Harness failure.",
              exitCode: 1,
              schema: standardSchema(
                v.strictObject({ result: waitResultSchema }),
              ),
              text: ({ result }) => renderWaitText(result),
            },
            cancelled: {
              description: "A turn completed after cancellation.",
              exitCode: 2,
              schema: standardSchema(
                v.strictObject({ result: waitResultSchema }),
              ),
              text: ({ result }) => renderWaitText(result),
            },
            killed: {
              description: "A turn completed after its session was killed.",
              exitCode: 3,
              schema: standardSchema(
                v.strictObject({ result: waitResultSchema }),
              ),
              text: ({ result }) => renderWaitText(result),
            },
            timeout: {
              description: "The observation budget ended with pending turns.",
              exitCode: 4,
              schema: standardSchema(
                v.strictObject({ result: waitResultSchema }),
              ),
              text: ({ result }) => renderWaitText(result),
            },
          },
        },
        failures: {
          queryFailed: {
            description: "The wait request could not be completed.",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) => text.line(`Wait failed: ${failure.code}`),
          },
        },
        async handler({ dependencies, input, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const result = await connection.wait({
              targets: input.targets as TurnHandle[],
              completion: input.completion,
              ...(input.timeout === undefined
                ? {}
                : { timeoutMs: Number(input.timeout) }),
            });
            const output = projectWaitResult(result);
            if (result.status === "timeout")
              return outcome.data.timeout({ result: output });
            if (result.completed.some((turn) => turn.stopReason === "failed"))
              return outcome.data.failed({ result: output });
            if (result.completed.some((turn) => turn.stopReason === "killed"))
              return outcome.data.killed({ result: output });
            if (
              result.completed.some((turn) => turn.stopReason === "cancelled")
            )
              return outcome.data.cancelled({ result: output });
            return outcome.data.completed({ result: output });
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.queryFailed({ failure: error.failure });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("interrupt")({
        kind: "command",
        parent: "reins",
        name: "interrupt",
        description: "Request interruption of one exact turn.",
        fields: {
          target: {
            kind: "positional",
            description: "Exact turn handle to interrupt.",
          },
          operation: {
            kind: "valueOption",
            longOption: "--operation",
            description: "Credential returned by prepare-operation interrupt.",
          },
        },
        input: standardSchema(
          v.object({ target: v.string(), operation: v.string() }),
        ),
        success: {
          kind: "data",
          variants: {
            result: {
              description: "The interruption request was accepted.",
              exitCode: 0,
              schema: standardSchema(interruptResultSchema),
              text: ({ turnHandle }) =>
                text.line(`Stop request accepted: ${turnHandle}`),
            },
          },
        },
        failures: {
          operationFailed: {
            description:
              "The interruption request could not be delivered or recovered.",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) =>
              text.line(`Interrupt failed: ${failure.code}`),
          },
        },
        async handler({ dependencies, input, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const result: InterruptResult = await connection.interrupt(
              { turnHandle: input.target as TurnHandle },
              input.operation as OperationCredential<"interrupt">,
            );
            return outcome.data.result(result);
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.operationFailed({
                failure: error.failure,
              });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("resolvePermission")({
        kind: "command",
        parent: "reins",
        name: "resolve-permission",
        description:
          "Resolve a pending Harness permission using a prepared credential.",
        fields: {
          permission: {
            kind: "positional",
            description:
              "Exact PermissionHandle from an observed permission fact.",
          },
          operation: {
            kind: "valueOption",
            longOption: "--operation",
            description:
              "Credential returned by prepare-operation resolve-permission.",
          },
          outcome: {
            kind: "valueOption",
            longOption: "--outcome",
            description: "The offered outcome: allow or deny.",
          },
          scope: {
            kind: "valueOption",
            longOption: "--scope",
            description: "Allow scope when the selected option offers it.",
          },
          feedback: {
            kind: "valueOption",
            longOption: "--feedback",
            description: "Optional denial feedback when supported.",
          },
        },
        input: permissionResolutionInputSchema,
        usageConstraints: [
          {
            kind: "when",
            all: [{ kind: "equals", field: "outcome", value: "allow" }],
            onMatch: { forbid: ["feedback"] },
            otherwise: { forbid: ["scope"] },
          },
        ],
        success: {
          kind: "data",
          variants: {
            result: {
              description: "Resolved permission handle",
              exitCode: 0,
              schema: standardSchema(
                v.strictObject({
                  permissionHandle: v.string(),
                  status: v.literal("resolved"),
                }),
              ),
              text: () => text.line("Permission resolved"),
            },
          },
        },
        failures: {
          operationFailed: {
            description:
              "The Harness permission could not be resolved or recovered",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) =>
              text.line(`Permission resolution failed: ${failure.code}`),
          },
        },
        async handler({ dependencies, input, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const resolution: PermissionResolution =
              input.outcome === "allow"
                ? { outcome: "allow", scope: input.scope ?? "once" }
                : input.feedback === undefined
                  ? { outcome: "deny" }
                  : { outcome: "deny", feedback: input.feedback };
            const result = await connection.resolvePermission(
              input.permission as PermissionHandle,
              resolution,
              input.operation as OperationCredential<"resolvePermission">,
            );
            return outcome.data.result(result);
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.operationFailed({
                failure: error.failure,
              });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("diagnostics")({
        kind: "command",
        parent: "reins",
        name: "diagnostics",
        description:
          "Query stored failure evidence and finite diagnostic snapshots.",
        fields: {
          id: {
            kind: "valueOption",
            longOption: "--id",
            description: "Return one exact diagnostic record.",
          },
          session: {
            kind: "valueOption",
            longOption: "--session",
            description: "Filter by an exact session handle.",
          },
          turn: {
            kind: "valueOption",
            longOption: "--turn",
            description: "Filter by an exact turn handle.",
          },
          harness: {
            kind: "valueOption",
            longOption: "--harness",
            description: "Filter by a runtime Harness id.",
          },
          source: {
            kind: "repeatableOption",
            longOption: "--source",
            description: "Filter by diagnostic source; may be repeated.",
          },
          kind: {
            kind: "repeatableOption",
            longOption: "--kind",
            description: "Filter by diagnostic kind; may be repeated.",
          },
          minSeverity: {
            kind: "valueOption",
            longOption: "--min-severity",
            description: "Minimum diagnostic severity.",
          },
          since: {
            kind: "valueOption",
            longOption: "--since",
            description: "Include diagnostics recorded at or after this time.",
          },
          until: {
            kind: "valueOption",
            longOption: "--until",
            description: "Include diagnostics recorded at or before this time.",
          },
          limit: {
            kind: "valueOption",
            longOption: "--limit",
            description: "Maximum records to return, from 1 to 1000.",
          },
        },
        input: diagnosticsInputSchema,
        usageConstraints: [
          {
            kind: "when",
            all: [{ kind: "present", field: "id" }],
            onMatch: {
              forbid: [
                "session",
                "turn",
                "harness",
                "source",
                "kind",
                "minSeverity",
                "since",
                "until",
                "limit",
              ],
            },
          },
        ],
        success: {
          kind: "data",
          variants: {
            result: {
              description: "Matching diagnostic records",
              exitCode: 0,
              schema: standardSchema(diagnosticsResultSchema),
              text: (result) => text.line(JSON.stringify(result)),
            },
          },
        },
        failures: {
          queryFailed: {
            description: "The diagnostic query failed",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) =>
              text.line(`Diagnostics query failed: ${failure.code}`),
          },
          diagnosticNotFound: {
            description: "The requested diagnostic record does not exist",
            exitCode: 65,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) =>
              text.line(`Diagnostic not found: ${failure.code}`),
          },
        },
        async handler({ dependencies, input, outcome }) {
          let connection: ReinsConnection | undefined;
          try {
            connection = await dependencies.connect();
            const query: DiagnosticsQuery =
              input.id === undefined
                ? {
                    ...(input.session === undefined
                      ? {}
                      : { sessionHandle: input.session as SessionHandle }),
                    ...(input.turn === undefined
                      ? {}
                      : { turnHandle: input.turn as TurnHandle }),
                    ...(input.harness === undefined
                      ? {}
                      : { harness: input.harness }),
                    ...(input.source === undefined
                      ? {}
                      : { sources: input.source }),
                    ...(input.kind === undefined ? {} : { kinds: input.kind }),
                    ...(input.minSeverity === undefined
                      ? {}
                      : { minSeverity: input.minSeverity }),
                    ...(input.since === undefined
                      ? {}
                      : { since: input.since }),
                    ...(input.until === undefined
                      ? {}
                      : { until: input.until }),
                    ...(input.limit === undefined
                      ? {}
                      : { limit: Number(input.limit) }),
                  }
                : { diagnosticId: input.id as DiagnosticId };
            const result: DiagnosticsResult =
              await connection.diagnostics(query);
            return outcome.data.result(result);
          } catch (error) {
            if (
              error instanceof ReinsSdkError &&
              error.failure.code === "diagnostic_not_found"
            )
              return outcome.failure.diagnosticNotFound({
                failure: error.failure,
              });
            if (error instanceof ReinsSdkError)
              return outcome.failure.queryFailed({ failure: error.failure });
            throw error;
          } finally {
            connection?.close();
          }
        },
      }),
      ...define.command("attach")({
        kind: "command",
        parent: "reins",
        name: "attach",
        description: "Observe stable facts for a Reins session or turn.",
        fields: {
          target: {
            kind: "positional",
            description: "A session handle or turn handle.",
          },
          scope: {
            kind: "valueOption",
            longOption: "--scope",
            description: "The exact target scope: session or turn.",
          },
          replay: {
            kind: "valueOption",
            longOption: "--replay",
            description:
              "Replay none, the available window, or after a cursor.",
          },
          cursor: {
            kind: "valueOption",
            longOption: "--cursor",
            description: "Opaque cursor required by --replay after.",
          },
        },
        input: attachInputSchema,
        usageConstraints: [
          {
            kind: "when",
            all: [{ kind: "equals", field: "replay", value: "after" }],
            onMatch: { require: ["cursor"] },
            otherwise: { forbid: ["cursor"] },
          },
        ],
        success: {
          kind: "stream",
          records: {
            established: {
              description: "The subscription target and replay window.",
              schema: standardSchema(
                v.strictObject({ establishment: attachEstablishmentSchema }),
              ),
              text: ({ establishment }) => {
                const value = establishment as AgentSubscriptionEstablishment;
                const { oldest, head, truncated } = value.window;
                return text.line(
                  `Event window: ${oldest ?? "empty"} through ${head ?? "empty"} (${truncated ? "truncated" : "complete"})`,
                );
              },
            },
            fact: {
              description: "A stable control domain fact.",
              schema: standardSchema(
                v.strictObject({ fact: attachFactSchema }),
              ),
              text: ({ fact }) =>
                text.line(`Fact: ${(fact as AgentFact).type}`),
            },
            presentation: {
              description: "A text or tool activity presentation.",
              schema: standardSchema(
                v.strictObject({ presentation: attachPresentationSchema }),
              ),
              text: ({ presentation }) =>
                text.fragment(
                  renderPresentation(presentation as AgentPresentation),
                ),
            },
            ended: {
              description: "The subscription ended normally.",
              schema: standardSchema(v.strictObject({ end: attachEndSchema })),
              text: ({ end }) =>
                text.line(
                  `[attach ended] ${(end as AgentSubscriptionEnd).reason}`,
                ),
            },
            permissionPrepared: {
              description:
                "The selected permission response and its recoverable operation credential, prepared but not executed.",
              schema: standardSchema(preparedPermissionResolutionSchema),
              text: (prepared) =>
                text.line(
                  `Permission response prepared (not executed): ${JSON.stringify(prepared)}`,
                ),
            },
          },
          text: () => text.silent,
        },
        failures: {
          attachFailed: {
            description: "The Reins subscription failed.",
            exitCode: 70,
            schema: standardSchema(
              v.strictObject({ failure: sdkFailureSchema }),
            ),
            text: ({ failure }) => text.line(`Attach failed: ${failure.code}`),
          },
          permissionInputClosed: {
            description:
              "Permission input ended before the response was prepared.",
            exitCode: 65,
            schema: standardSchema(
              v.strictObject({ code: v.literal("permission_input_closed") }),
            ),
            text: () =>
              text.line(
                "error: Permission input ended before the response was prepared",
              ),
          },
          permissionChoiceInvalid: {
            description: "The selected permission option was not offered.",
            exitCode: 64,
            schema: standardSchema(
              v.strictObject({ code: v.literal("permission_choice_invalid") }),
            ),
            text: () =>
              text.line("error: Choose one of the offered permission options"),
          },
        },
        async *handler({ dependencies, input, outcome }) {
          const scope = input.scope;
          if (scope === undefined) throw new Error("attachScopeRequired");
          const target =
            scope === "session"
              ? {
                  scope,
                  sessionHandle: input.target as SessionHandle,
                }
              : { scope, turnHandle: input.target as TurnHandle };
          const replay =
            input.replay === "after"
              ? {
                  mode: "after" as const,
                  cursor: input.cursor as ResumeCursor,
                }
              : { mode: input.replay ?? "available" };
          let connection: ReinsConnection | undefined;
          let subscription:
            | Awaited<ReturnType<ReinsConnection["attach"]>>
            | undefined;
          const nonInteractiveReplayFacts = new Set<AgentFact["factId"]>();
          let subscriptionEnded = false;
          let promptAbort: AbortController | undefined;
          let interrupt: (() => void) | undefined;
          let interrupted = false;
          try {
            connection = await dependencies.connect();
            subscription = await connection.attach(target, replay);
            const attached = subscription;
            void attached.done.then(
              () => {
                subscriptionEnded = true;
                promptAbort?.abort();
              },
              () => {
                subscriptionEnded = true;
                promptAbort?.abort();
              },
            );
            interrupt = () => {
              interrupted = true;
              promptAbort?.abort();
              subscription?.close();
              connection?.close();
              dependencies.cancelOutput();
            };
            process.once("SIGINT", interrupt);
            yield outcome.record.established({
              establishment: attached.establishment,
            });
            const project = createPresentationProjector();
            const replayedFacts: AgentFact[] = [];
            let replayFailed = false;
            let replayFailure: ReinsSdkError | undefined;
            if (dependencies.outputFormat === "text") {
              for (
                let index = 0;
                index < attached.establishment.replayed;
                index += 1
              ) {
                let item: IteratorResult<AgentFact>;
                try {
                  item = await attached.next();
                } catch (error) {
                  if (!(error instanceof ReinsSdkError)) throw error;
                  replayFailed = true;
                  replayFailure = error;
                  break;
                }
                if (item.done) break;
                replayedFacts.push(item.value);
              }
              const resolvedPermissions = new Set<PermissionHandle>();
              const completedTurns = new Set<TurnHandle>();
              for (const fact of replayedFacts) {
                if (fact.type === "permission.resolved")
                  resolvedPermissions.add(fact.permissionHandle);
                else if (fact.type === "turn.completed")
                  completedTurns.add(fact.turnHandle);
              }
              for (const fact of replayedFacts) {
                if (
                  fact.type === "permission.requested" &&
                  (replayFailed ||
                    resolvedPermissions.has(fact.permissionHandle) ||
                    completedTurns.has(fact.turnHandle))
                )
                  nonInteractiveReplayFacts.add(fact.factId);
              }
            }
            const facts =
              replayedFacts.length === 0 && !replayFailed
                ? attached
                : (async function* () {
                    yield* replayedFacts;
                    if (replayFailed) throw replayFailure;
                    for await (const fact of attached) yield fact;
                  })();
            for await (const fact of facts) {
              if (dependencies.outputFormat === "structured") {
                yield outcome.record.fact({ fact });
              } else {
                for (const presentation of project(fact))
                  yield outcome.record.presentation({ presentation });
                if (fact.type === "permission.requested") {
                  if (
                    interrupted ||
                    subscriptionEnded ||
                    nonInteractiveReplayFacts.has(fact.factId)
                  )
                    continue;
                  if (fact.options.length === 0)
                    return outcome.failure.permissionChoiceInvalid({
                      code: "permission_choice_invalid",
                    });
                  const currentPromptAbort = new AbortController();
                  promptAbort = currentPromptAbort;
                  try {
                    const choice = await dependencies.readLine(
                      renderPermissionPrompt(fact),
                      currentPromptAbort.signal,
                    );
                    if (currentPromptAbort.signal.aborted) break;
                    if (choice === undefined)
                      return outcome.failure.permissionInputClosed({
                        code: "permission_input_closed",
                      });
                    const index = Number(choice.trim());
                    if (
                      !Number.isInteger(index) ||
                      index < 1 ||
                      index > fact.options.length
                    )
                      return outcome.failure.permissionChoiceInvalid({
                        code: "permission_choice_invalid",
                      });
                    const option = fact.options[index - 1]!;
                    const resolution = await choosePermissionResolution(
                      dependencies,
                      option,
                      currentPromptAbort.signal,
                    );
                    if (currentPromptAbort.signal.aborted) break;
                    if (resolution === undefined)
                      return outcome.failure.permissionInputClosed({
                        code: "permission_input_closed",
                      });
                    yield outcome.record.permissionPrepared({
                      permissionHandle: fact.permissionHandle,
                      credential:
                        connection.prepareOperation("resolvePermission"),
                      resolution,
                    });
                    return outcome.streamSuccess();
                  } catch (error) {
                    if (error instanceof Error && error.name === "AbortError")
                      break;
                    throw error;
                  } finally {
                    if (promptAbort === currentPromptAbort)
                      promptAbort = undefined;
                  }
                }
              }
            }
            const end = await subscription.done;
            yield outcome.record.ended({ end });
            return outcome.streamSuccess();
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.attachFailed({ failure: error.failure });
            throw error;
          } finally {
            if (interrupt !== undefined)
              process.removeListener("SIGINT", interrupt);
            subscription?.close();
            connection?.close();
          }
        },
      }),
    },
  });
}

export async function main(runtime: CliRuntime): Promise<number> {
  const contract = createCli(runtime.version);
  let interrupted = false;
  try {
    const invocation = parseCliInvocation(contract, runtime.argv.slice(2));
    const outputFormat =
      invocation.kind === "parsed" ? invocation.outputFormat : "structured";
    const termination = await executeCli(contract, {
      invocation,
      dependencies: {
        ...runtime.dependencies,
        outputFormat,
        cancelOutput() {
          interrupted = true;
          runtime.cancelOutput();
        },
      },
      write: runtime.write,
    });
    return termination.exitCode;
  } catch (error) {
    if (interrupted) return 0;
    if (
      error instanceof CliWriteError &&
      error.destination === "stdout" &&
      isNodeBrokenPipe(error)
    )
      return 0;
    throw error;
  }
}

function projectWaitResult(
  result: WaitResult,
): v.InferOutput<typeof waitResultSchema> {
  return {
    status: result.status,
    completed: result.completed.map((turn) =>
      turn.stopReason === "failed"
        ? {
            ...turn,
            message: harnessFailureMessage(
              turn.failure,
              turn.diagnosticId as Parameters<typeof harnessFailureMessage>[1],
            ),
          }
        : turn,
    ),
    pending: result.pending.map((turnHandle) => ({ turnHandle })),
  };
}

function renderWaitText(result: v.InferOutput<typeof waitResultSchema>) {
  const lines: string[] = [];
  if (result.status === "timeout")
    lines.push("Timed out waiting for turn completion");
  for (const turn of result.completed) {
    lines.push(`Turn completed: ${turn.stopReason} (${turn.turnHandle})`);
    if (turn.stopReason === "failed") lines.push(turn.message);
    if (turn.finalReply !== null) lines.push(turn.finalReply);
  }
  for (const turn of result.pending) lines.push(`Pending: ${turn.turnHandle}`);
  const [first, ...rest] = lines;
  if (first === undefined) return text.line("No turn facts returned");
  return text.lines([first, ...rest]);
}

function renderPresentation(presentation: AgentPresentation): string {
  if (presentation.type === "text") {
    const prefix =
      presentation.operation === "replace"
        ? `\n[message updated] ${presentation.role}: `
        : presentation.start
          ? `${presentation.role}: `
          : "";
    const suffix =
      presentation.complete && !presentation.content.endsWith("\n") ? "\n" : "";
    return `${prefix}${presentation.content}${suffix}` || " ";
  }
  if (presentation.type === "tool.requested")
    return `[tool] ${presentation.name} requested\n`;
  if (presentation.type === "tool.completed")
    return `[tool] ${presentation.name} completed\n`;
  if (presentation.type === "permission.requested")
    return `[permission requested] ${presentation.kind}\n`;
  if (presentation.type === "permission.resolved")
    return `[permission resolved] ${presentation.permissionHandle}\n`;
  if (presentation.type === "turn.completed")
    return `[turn completed] ${presentation.stopReason}\n`;
  if (presentation.type === "turn.started")
    return `[turn started] ${presentation.turnHandle}\n`;
  if (presentation.type === "session.killed")
    return `[session killed] ${presentation.sessionHandle}\n`;
  if (presentation.type === "session.created")
    return `Created session ${presentation.sessionHandle}\n`;
  return "\n";
}

function renderPermissionPrompt(
  fact: Extract<AgentFact, { type: "permission.requested" }>,
): string {
  const choices = fact.options
    .map((option, index) => `${index + 1}) ${permissionOptionLabel(option)}`)
    .join("\n");
  return `Permission requested: ${fact.kind}\n${choices}\nChoose (1-${fact.options.length}): `;
}

function permissionOptionLabel(option: PermissionOption): string {
  if (option.outcome === "allow")
    return option.scope === "once" ? "Allow once" : "Allow for this session";
  return option.feedback ? "Deny with feedback" : "Deny";
}

async function choosePermissionResolution(
  dependencies: ReinsCliDependencies,
  option: PermissionOption,
  signal: AbortSignal,
): Promise<PermissionResolution | undefined> {
  if (option.outcome === "allow") return option;
  if (!option.feedback) return { outcome: "deny" };
  const feedback = await dependencies.readLine("Feedback (optional): ", signal);
  return feedback === undefined || feedback.length === 0
    ? feedback === undefined
      ? undefined
      : { outcome: "deny" }
    : { outcome: "deny", feedback };
}
