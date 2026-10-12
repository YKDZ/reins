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
  type AgentFact,
  type AgentPresentation,
  type AgentSubscriptionEstablishment,
  type AgentSubscriptionEnd,
  type ReinsConnection,
  type SessionFilter,
  type SessionInfo,
  type SessionHandle,
  type TurnHandle,
  type ResumeCursor,
} from "@ykdz/reins-sdk";
import * as v from "valibot";

import { standardSchema } from "./standard-schema.ts";

export type ReinsCliDependencies = {
  readonly connect: () => Promise<ReinsConnection>;
  readonly outputFormat: OutputFormat;
};

type ReinsCliRuntimeDependencies = Pick<ReinsCliDependencies, "connect">;

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly version: string;
  readonly write: WriteCliOutput;
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
  ...harnessFailureSchema.entries,
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

const sdkFailureSchema = v.strictObject({
  code: v.string(),
  facts: v.record(v.string(), v.unknown()),
});

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
  v.pipe(
    v.strictObject({
      target: v.string(),
      scope: v.optional(v.picklist(["session", "turn"])),
      replay: v.optional(v.picklist(["none", "available", "after"])),
      cursor: v.optional(v.string()),
    }),
    v.check(
      (input) =>
        input.scope !== undefined &&
        (input.replay === "after") === (input.cursor !== undefined),
    ),
  ),
  ["check"],
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
      },
      wording: {
        commandPlaceholder: "command",
        choices: "Choices: {choices}",
        default: "Default: {value}",
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
            return outcome.data.result(result);
          } catch (error) {
            if (error instanceof ReinsSdkError)
              return outcome.failure.queryFailed({ failure: error.failure });
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
          let interrupt: (() => void) | undefined;
          try {
            connection = await dependencies.connect();
            subscription = await connection.attach(target, replay);
            interrupt = () => subscription?.close();
            process.once("SIGINT", interrupt);
            yield outcome.record.established({
              establishment: subscription.establishment,
            });
            const project = createPresentationProjector();
            for await (const fact of subscription) {
              if (dependencies.outputFormat === "structured") {
                yield outcome.record.fact({ fact });
              } else {
                for (const presentation of project(fact))
                  yield outcome.record.presentation({ presentation });
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
  try {
    const invocation = parseCliInvocation(contract, runtime.argv.slice(2));
    const outputFormat =
      invocation.kind === "parsed" ? invocation.outputFormat : "structured";
    const termination = await executeCli(contract, {
      invocation,
      dependencies: { ...runtime.dependencies, outputFormat },
      write: runtime.write,
    });
    return termination.exitCode;
  } catch (error) {
    if (
      error instanceof CliWriteError &&
      error.destination === "stdout" &&
      isNodeBrokenPipe(error)
    )
      return 0;
    throw error;
  }
}

function renderPresentation(presentation: AgentPresentation): string {
  if (presentation.type === "text") {
    const prefix = presentation.start ? `${presentation.role}: ` : "";
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
