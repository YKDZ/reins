import {
  CliWriteError,
  defineCli,
  executeCli,
  helpCapability,
  outputCapability,
  parseCliInvocation,
  versionCapability,
  text,
  type WriteCliOutput,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe } from "@ykdz/cli-contract/node";
import {
  ReinsSdkError,
  type CapabilitiesResult,
  type ReinsConnection,
  type SessionFilter,
  type SessionInfo,
  type SessionHandle,
} from "@ykdz/reins-sdk";
import * as v from "valibot";

import { standardSchema } from "./standard-schema.ts";

export type ReinsCliDependencies = {
  readonly connect: () => Promise<ReinsConnection>;
};

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly version: string;
  readonly write: WriteCliOutput;
  readonly dependencies: ReinsCliDependencies;
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
    output: outputCapability({ defaultFormat: "structured" }),
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
    },
  });
}

export async function main(runtime: CliRuntime): Promise<number> {
  const contract = createCli(runtime.version);
  try {
    const termination = await executeCli(contract, {
      invocation: parseCliInvocation(contract, runtime.argv.slice(2)),
      dependencies: runtime.dependencies,
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
