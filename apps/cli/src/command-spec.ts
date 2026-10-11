import {
  DIAGNOSTIC_KINDS,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES,
  diagnosticIdSchema,
  permissionIdSchema,
  permissionHandleSchema,
  resumeCursorSchema,
  type ResumeCursor,
  decodePermissionHandle,
  type PermissionTarget,
  sessionIdSchema,
  sessionNameSchema,
  turnIdSchema,
  turnHandleSchema,
  decodeTurnHandle,
  utcMillisecondTimestampSchema,
  type DiagnosticId,
  type PermissionId,
  type SessionId,
  type SessionName,
  type TurnId,
  type TurnTarget,
} from "@reins/protocol";
import { PUBLISHER_CAPABILITIES } from "@reins/workspace-protocol";
import * as v from "valibot";

import {
  usageError,
  usageErrors,
  type UsageError,
  type UsageIssue,
} from "./errors.ts";
import type { OutputMode } from "./output.ts";

export type ValueKind =
  | { readonly type: "text" }
  | { readonly type: "sessionName"; readonly hint: string }
  | { readonly type: "sessionId"; readonly hint: string }
  | { readonly type: "turnId"; readonly hint: string }
  | { readonly type: "turnHandle"; readonly hint: string }
  | { readonly type: "permissionId"; readonly hint: string }
  | { readonly type: "permissionHandle"; readonly hint: string }
  | { readonly type: "resumeCursor"; readonly hint: string }
  | { readonly type: "diagnosticId"; readonly hint: string }
  | { readonly type: "time"; readonly hint: string }
  | { readonly type: "boolean" }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | {
      readonly type: "number";
      readonly integer?: boolean;
      readonly min?: number;
      readonly max?: number;
      readonly hint: string;
    }
  | { readonly type: "jsonObject"; readonly hint: string }
  | {
      readonly type: "dynamic";
      readonly source: "harness" | "model" | "reasoning";
      readonly hint: string;
    };

export type CommandArg = {
  readonly name: string;
  readonly variadic?: boolean;
  readonly description: string;
  readonly kind: ValueKind;
};

export type CommandOption = {
  readonly name: string;
  readonly flags: string;
  readonly required?: boolean;
  readonly variadic?: boolean;
  readonly defaultValue?: string;
  readonly description: string;
  readonly kind: ValueKind;
};

export type CommandSpec = {
  readonly name: string;
  readonly description: string;
  readonly args: readonly CommandArg[];
  readonly options: readonly CommandOption[];
  readonly usage?: string;
  readonly children?: readonly string[];
  readonly constraints?: readonly CommandConstraint[];
};

export type CommandConstraint =
  | {
      readonly type: "exclusive";
      readonly field: string;
      readonly with: readonly string[];
      readonly hint: string;
    }
  | {
      readonly type: "requires";
      readonly field: string;
      readonly required: string;
      readonly hint: string;
    }
  | {
      readonly type: "orderedTime";
      readonly since: string;
      readonly until: string;
      readonly hint: string;
    };

export const ROOT_USAGE = "[options] <command>";
const sessionNameHint =
  "Use a lowercase slug (max 32): [a-z][a-z0-9]*(?:-[a-z0-9]+)*; reserved: daemon, core, adapter, harness, root; example: code-reviewer";

export function defineCommand<const S extends CommandSpec>(spec: S): S {
  return spec;
}

const commandSpecData = [
  defineCommand({
    name: "spawn",
    description: "Create a worker session",
    args: [
      {
        name: "harness",
        description: "harness id from capabilities",
        kind: {
          type: "dynamic",
          source: "harness",
          hint: "Run 'reins capabilities' to list valid harnesses",
        },
      },
      {
        name: "message",
        variadic: true,
        description: "initial message",
        kind: { type: "text" },
      },
    ],
    options: [
      {
        name: "agent",
        flags: "--agent <name>",
        description: "agent profile name",
        kind: { type: "text" },
      },
      {
        name: "model",
        flags: "--model <id>",
        description: "model id from capabilities",
        kind: {
          type: "dynamic",
          source: "model",
          hint: "Run 'reins capabilities' to list valid models",
        },
      },
      {
        name: "reasoning",
        flags: "--reasoning <effort>",
        description: "reasoning effort supported by the model",
        kind: {
          type: "dynamic",
          source: "reasoning",
          hint: "Run 'reins capabilities' to list valid reasoning efforts",
        },
      },
      {
        name: "cwd",
        flags: "--cwd <path>",
        description:
          "local working directory in the daemon filesystem namespace (default: CLI cwd; relative paths resolve from CLI cwd)",
        kind: { type: "text" },
      },
      {
        name: "authorizationMode",
        flags: "--authorization-mode <mode>",
        description: "interactive | allow-all",
        kind: { type: "enum", values: ["interactive", "allow-all"] },
      },
      {
        name: "sandbox",
        flags: "--sandbox <value>",
        description: "harness-specific sandbox configuration",
        kind: { type: "text" },
      },
      {
        name: "name",
        flags: "--name <session-name>",
        required: true,
        description: sessionNameHint,
        kind: { type: "sessionName", hint: sessionNameHint },
      },
      {
        name: "captureHarnessStderr",
        flags: "--capture-harness-stderr",
        description: "capture harness stderr as diagnostics",
        kind: { type: "boolean" },
      },
    ],
  }),
  defineCommand({
    name: "send",
    description: "Send to an explicit active turn or create a new turn",
    args: [
      {
        name: "target",
        description: "SessionHandle for new_turn or TurnHandle for active_turn",
        kind: { type: "text" },
      },
      {
        name: "message",
        variadic: true,
        description: "message text",
        kind: { type: "text" },
      },
    ],
    options: [
      {
        name: "placement",
        flags: "--placement <placement>",
        required: true,
        description: "Explicit message placement",
        kind: { type: "enum", values: ["active_turn", "new_turn"] },
      },
    ],
  }),
  defineCommand({
    name: "wait",
    description: "Wait for turns to complete",
    args: [
      {
        name: "turns",
        variadic: true,
        description: "complete turn handles",
        kind: { type: "turnHandle", hint: "Expected a complete TurnHandle" },
      },
    ],
    options: [
      {
        name: "completion",
        flags: "--completion <mode>",
        required: true,
        description: "completion condition",
        kind: { type: "enum", values: ["any", "all"] },
      },
      {
        name: "timeout",
        flags: "--timeout <ms>",
        description:
          "observation timeout in milliseconds; 0 queries immediately, omitted waits indefinitely",
        kind: {
          type: "number",
          min: 0,
          hint: "Expected a non-negative number",
        },
      },
    ],
  }),
  defineCommand({
    name: "interrupt",
    description: "Request stopping one exact active turn",
    args: [
      {
        name: "target",
        description: "exact TurnHandle",
        kind: { type: "text" },
      },
    ],
    options: [],
  }),
  defineCommand({
    name: "kill",
    description: "Kill one session permanently",
    args: [
      {
        name: "sessionId",
        description: "session id",
        kind: { type: "sessionId", hint: "Expected a valid SessionId" },
      },
    ],
    options: [],
  }),
  defineCommand({
    name: "list",
    description: "List sessions",
    args: [],
    options: [
      {
        name: "session",
        flags: "--session <session-handle>",
        description: "query an exact session",
        kind: { type: "sessionId", hint: "Expected a valid SessionHandle" },
      },
      {
        name: "harness",
        flags: "--harness <id>",
        description: "filter by harness",
        kind: { type: "text" },
      },
      {
        name: "state",
        flags: "--state <state>",
        description: "filter by session state",
        kind: { type: "enum", values: ["busy", "idle", "killed"] },
      },
      {
        name: "name",
        flags: "--name <session-name>",
        description: "filter by session name",
        kind: { type: "sessionName", hint: sessionNameHint },
      },
      {
        name: "model",
        flags: "--model <id>",
        description: "filter by model",
        kind: { type: "text" },
      },
    ],
  }),
  defineCommand({
    name: "attach",
    description: "Subscribe to an exact session or turn",
    args: [
      {
        name: "target",
        description: "SessionHandle or complete TurnHandle",
        kind: { type: "text" },
      },
    ],
    options: [
      {
        name: "scope",
        flags: "--scope <session|turn>",
        required: true,
        description: "subscription scope",
        kind: { type: "enum", values: ["session", "turn"] },
      },
      {
        name: "replay",
        flags: "--replay <none|available|after>",
        required: true,
        description: "bounded event history policy; after requires --cursor",
        kind: { type: "enum", values: ["none", "available", "after"] },
      },
      {
        name: "cursor",
        flags: "--cursor <ResumeCursor>",
        description: "resume an interrupted attach; only with --replay after",
        kind: {
          type: "resumeCursor",
          hint: "Use the complete ResumeCursor from a disconnected attach",
        },
      },
    ],
  }),
  defineCommand({
    name: "diagnostics",
    description: "Query a finite snapshot of stored diagnostics",
    args: [],
    constraints: [
      {
        type: "exclusive",
        field: "id",
        with: [
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
        hint: "Use --id alone, or use filters without --id",
      },
      {
        type: "requires",
        field: "turn",
        required: "session",
        hint: "--turn requires --session",
      },
      {
        type: "orderedTime",
        since: "since",
        until: "until",
        hint: "--since must be earlier than or equal to --until",
      },
    ],
    options: [
      {
        name: "id",
        flags: "--id <diagnostic-id>",
        description: "exact diagnostic id with checksum",
        kind: {
          type: "diagnosticId",
          hint: "Expected a DiagnosticId with a valid checksum",
        },
      },
      {
        name: "session",
        flags: "--session <session-id>",
        description: "filter by session",
        kind: { type: "sessionId", hint: "Expected a valid SessionId" },
      },
      {
        name: "turn",
        flags: "--turn <turn-id>",
        description: "filter by turn (requires --session)",
        kind: { type: "turnId", hint: "Expected a valid TurnId" },
      },
      {
        name: "harness",
        flags: "--harness <id>",
        description: "filter by harness",
        kind: { type: "text" },
      },
      {
        name: "source",
        flags: "--source <sources...>",
        variadic: true,
        description: "source filter; repeated values are OR",
        kind: { type: "enum", values: DIAGNOSTIC_SOURCES },
      },
      {
        name: "kind",
        flags: "--kind <kinds...>",
        variadic: true,
        description: "kind filter; repeated values are OR",
        kind: { type: "enum", values: DIAGNOSTIC_KINDS },
      },
      {
        name: "minSeverity",
        flags: "--min-severity <severity>",
        description: "minimum severity",
        kind: { type: "enum", values: DIAGNOSTIC_SEVERITIES },
      },
      {
        name: "since",
        flags: "--since <timestamp>",
        description: "inclusive UTC timestamp",
        kind: { type: "time", hint: "Expected an ISO 8601 UTC timestamp" },
      },
      {
        name: "until",
        flags: "--until <timestamp>",
        description: "inclusive UTC timestamp",
        kind: { type: "time", hint: "Expected an ISO 8601 UTC timestamp" },
      },
      {
        name: "limit",
        flags: "--limit <n>",
        description: "latest matching records (default: 100; 1..1000)",
        kind: {
          type: "number",
          integer: true,
          min: 1,
          max: 1000,
          hint: "Expected an integer from 1 to 1000",
        },
      },
    ],
  }),
  defineCommand({
    name: "capabilities",
    description: "List harnesses, models and reasoning efforts",
    args: [],
    options: [],
  }),
  defineCommand({
    name: "resolve-permission",
    description:
      "Resolve a pending permission using its complete PermissionHandle",
    args: [
      {
        name: "permissionHandle",
        description: "complete PermissionHandle",
        kind: {
          type: "permissionHandle",
          hint: "Expected a valid PermissionHandle",
        },
      },
    ],
    options: [
      {
        name: "outcome",
        flags: "--outcome <allow|deny>",
        required: true,
        description: "resolution outcome",
        kind: { type: "enum", values: ["allow", "deny"] },
      },
      {
        name: "scope",
        flags: "--scope <once|session>",
        description: "allow scope (default: once)",
        kind: { type: "enum", values: ["once", "session"] },
      },
      {
        name: "feedback",
        flags: "--feedback <text>",
        description: "deny feedback visible to the worker",
        kind: { type: "text" },
      },
    ],
  }),
  defineCommand({
    name: "retry",
    description:
      "Explicitly recover an uncertain command using its RetryToken and unchanged original parameters",
    args: [
      {
        name: "token",
        description: "RetryToken from command_outcome_unknown",
        kind: { type: "text" },
      },
    ],
    options: [
      {
        name: "params",
        flags: "--params <json>",
        required: true,
        description:
          "original caller parameters as JSON; the token retains the original directory facts",
        kind: {
          type: "jsonObject",
          hint: "Supply the original parameters without changing their meaning",
        },
      },
    ],
  }),
] as const satisfies readonly CommandSpec[];

export type CommandName = (typeof commandSpecData)[number]["name"];

export const commandSpecs: readonly (CommandSpec & {
  readonly name: CommandName;
})[] = commandSpecData;

const text = { type: "text" } as const;
const nativeCwd = {
  name: "C",
  flags: "-C <path>",
  description: "native directory context",
  kind: text,
} as const;

export const workspaceCommandSpecs = [
  defineCommand({
    name: "workspace import-git",
    description:
      "Import a published Git bundle into a new reference without checkout or merge",
    args: [{ name: "publication", description: "publication id", kind: text }],
    options: [
      {
        name: "repository",
        flags: "--repository <path>",
        required: true,
        description: "target Git repository",
        kind: text,
      },
      {
        name: "ref",
        flags: "--ref <reference>",
        required: true,
        description: "new fully qualified Git reference",
        kind: text,
      },
      {
        name: "commit",
        flags: "--commit <object>",
        required: true,
        description: "full commit object name advertised by the bundle",
        kind: text,
      },
    ],
  }),
  defineCommand({
    name: "workspace publications",
    description: "Query files explicitly published from this worktree",
    args: [],
    options: [nativeCwd],
  }),
  defineCommand({
    name: "workspace receive",
    description:
      "Explicitly receive one fixed publication outside the active tree",
    args: [{ name: "publication", description: "publication id", kind: text }],
    options: [
      {
        name: "directory",
        flags: "--directory <path>",
        required: true,
        description: "local receipt directory",
        kind: text,
      },
      {
        name: "activeRoot",
        flags: "--active-root <path>",
        required: true,
        description: "active Git worktree root",
        kind: text,
      },
    ],
  }),
  defineCommand({
    name: "workspace receipts",
    description:
      "List this consumer's received files, sources and actual locations",
    args: [],
    options: [
      {
        name: "directory",
        flags: "--directory <path>",
        required: true,
        description: "local receipt directory",
        kind: text,
      },
    ],
  }),
  defineCommand({
    name: "workspace remove-publication",
    description:
      "Explicitly remove one published copy without removing receipts",
    args: [{ name: "publication", description: "publication id", kind: text }],
    options: [],
  }),
  defineCommand({
    name: "workspace remove-receipt",
    description:
      "Explicitly remove one local receipt without removing its publication",
    args: [{ name: "receipt", description: "receipt id", kind: text }],
    options: [
      {
        name: "directory",
        flags: "--directory <path>",
        required: true,
        description: "local receipt directory",
        kind: text,
      },
    ],
  }),
  defineCommand({
    name: "workspace handoff",
    description:
      "Transfer a fixed commit and explicitly selected files to a new Git worktree",
    args: [],
    options: [
      {
        name: "repository",
        flags: "--repository <path>",
        required: true,
        description: "one caller-native Git root",
        kind: text,
      },
      {
        name: "commit",
        flags: "--commit <sha>",
        required: true,
        description: "full fixed commit object name",
        kind: text,
      },
      {
        name: "subdirectory",
        flags: "--subdirectory <path>",
        required: true,
        description: "relative target working directory",
        kind: text,
      },
      {
        name: "binding",
        flags: "--binding <refs...>",
        required: true,
        variadic: true,
        description: "explicit harness binding references",
        kind: text,
      },
      {
        name: "indexFile",
        flags: "--index-file <paths...>",
        variadic: true,
        description: "explicit repository-relative staged file versions",
        kind: text,
      },
      {
        name: "worktreeFile",
        flags: "--worktree-file <paths...>",
        variadic: true,
        description: "explicit repository-relative working file versions",
        kind: text,
      },
    ],
  }),
  defineCommand({
    name: "workspace harnesses",
    description: "Discover explicit project harness bindings",
    args: [],
    options: [nativeCwd],
  }),
  defineCommand({
    name: "workspace attach",
    description:
      "Prepare explicitly selected harness bindings without starting a worker",
    args: [],
    options: [
      nativeCwd,
      {
        name: "binding",
        flags: "--binding <refs...>",
        required: true,
        variadic: true,
        description: "explicit harness binding references",
        kind: text,
      },
    ],
  }),
  defineCommand({
    name: "workspace history",
    description: "Query durable consumed events across worktree attachments",
    args: [],
    options: [
      nativeCwd,
      {
        name: "allWorktrees",
        flags: "--all-worktrees",
        description: "query this consumer's worktrees",
        kind: { type: "boolean" },
      },
    ],
  }),
  defineCommand({
    name: "workspace status",
    description: "Inspect native worktree preparation facts",
    args: [],
    options: [nativeCwd],
  }),
  defineCommand({
    name: "workspace detach",
    description: "Release an environment with an explicit session disposition",
    args: [],
    options: [
      nativeCwd,
      {
        name: "sessionDisposition",
        flags: "--session-disposition <value>",
        required: true,
        description: "require_none or kill",
        kind: { type: "enum", values: ["require_none", "kill"] },
      },
    ],
  }),
] as const satisfies readonly CommandSpec[];

export const publisherCommandSpecs: readonly CommandSpec[] =
  PUBLISHER_CAPABILITIES.map((capability) =>
    defineCommand({
      name: capability.name,
      description: capability.description,
      args: [{ name: "file", description: "selected file", kind: text }],
      options: [],
    }),
  );

export const workspaceGroupSpec: CommandSpec = {
  name: "workspace",
  description: "Workspace operations",
  args: [],
  options: [],
  usage: "[options] <command>",
  children: workspaceCommandSpecs.map((spec) =>
    spec.name.slice("workspace ".length),
  ),
};

export const publisherGroupSpec: CommandSpec = {
  name: "",
  description: "Publisher operations",
  args: [],
  options: [],
  usage: "[options] <command>",
  children: publisherCommandSpecs.map((spec) => spec.name),
};

type CommandSpecData = (typeof commandSpecData)[number];

type ParsedValue<K extends ValueKind> = K extends {
  readonly type: "resumeCursor";
}
  ? ResumeCursor
  : K extends { readonly type: "text" }
    ? string
    : K extends { readonly type: "sessionName" }
      ? SessionName
      : K extends { readonly type: "sessionId" }
        ? SessionId
        : K extends { readonly type: "turnHandle" }
          ? TurnTarget
          : K extends { readonly type: "turnId" }
            ? TurnId
            : K extends { readonly type: "permissionHandle" }
              ? PermissionTarget
              : K extends { readonly type: "permissionId" }
                ? PermissionId
                : K extends { readonly type: "diagnosticId" }
                  ? DiagnosticId
                  : K extends { readonly type: "time" }
                    ? string
                    : K extends { readonly type: "boolean" }
                      ? boolean
                      : K extends {
                            readonly type: "enum";
                            readonly values: readonly (infer E extends
                              string)[];
                          }
                        ? E
                        : K extends { readonly type: "number" }
                          ? number
                          : K extends { readonly type: "jsonObject" }
                            ? Record<string, unknown>
                            : K extends { readonly type: "dynamic" }
                              ? string
                              : never;

type FieldValue<F extends CommandArg | CommandOption> = F extends {
  readonly variadic: true;
}
  ? readonly ParsedValue<F["kind"]>[]
  : ParsedValue<F["kind"]>;

type ParsedArgs<A extends readonly CommandArg[]> = {
  readonly [I in keyof A]: A[I] extends CommandArg ? FieldValue<A[I]> : never;
};

type RequiredOption<O extends CommandOption> = O extends
  | { readonly required: true }
  | { readonly defaultValue: string }
  ? O
  : never;

type OptionalOption<O extends CommandOption> = O extends
  | { readonly required: true }
  | { readonly defaultValue: string }
  ? never
  : O;

type ParsedOptions<O extends readonly CommandOption[]> = {
  readonly [P in O[number] as RequiredOption<P>["name"]]: FieldValue<P>;
} & {
  readonly [P in O[number] as OptionalOption<P>["name"]]?: FieldValue<P>;
};

type InvocationFor<S extends CommandSpecData> = {
  readonly command: S["name"];
  readonly contextCwd?: string;
  readonly args: ParsedArgs<S["args"]>;
  readonly options: ParsedOptions<S["options"]>;
  readonly mode: OutputMode;
};

export type CommandInvocationFor<N extends CommandName> = N extends CommandName
  ? InvocationFor<Extract<CommandSpecData, { readonly name: N }>>
  : never;

export type CommandInvocation = {
  readonly [N in CommandName]: CommandInvocationFor<N>;
}[CommandName];

export function commandSpecForName(name: string): CommandSpec | undefined {
  return (
    commandSpecs.find((spec) => spec.name === name) ??
    workspaceCommandSpecs.find((spec) => spec.name === name) ??
    publisherCommandSpecs.find((spec) => spec.name === name)
  );
}

export function commandSpecForToken(
  argv: readonly string[],
  commandSet: "root" | "publisher" = "root",
): CommandSpec | undefined {
  const commandIndex = commandTokenIndex(argv, commandSet === "root");
  if (commandIndex === -1) return undefined;
  const commandToken = argv[commandIndex];
  if (commandSet === "publisher") {
    return publisherCommandSpecs.find((spec) => spec.name === commandToken);
  }
  if (commandToken === "workspace") {
    const child = argv
      .slice(commandIndex + 1)
      .find((token) => !token.startsWith("-"));
    return (
      workspaceCommandSpecs.find(
        (spec) => spec.name === `workspace ${child}`,
      ) ?? workspaceGroupSpec
    );
  }
  return commandToken === undefined
    ? undefined
    : (commandSpecs.find((candidate) => candidate.name === commandToken) ??
        publisherCommandSpecs.find(
          (candidate) => candidate.name === commandToken,
        ));
}

export function flagDisplay(flags: string): string {
  const first = flags.split(/\s+/u)[0];
  return first === undefined ? flags : first;
}

export function usageFor(spec: CommandSpec | undefined): string {
  if (spec === undefined) return ROOT_USAGE;
  if (spec.usage !== undefined) return spec.usage;
  let usage = "";
  for (const arg of spec.args) {
    usage += ` <${arg.name}${arg.variadic === true ? "..." : ""}>`;
  }
  for (const option of spec.options) {
    if (option.required !== true) continue;
    usage += ` ${option.flags}`;
  }
  usage += " [options]";
  return usage.trimStart();
}

export function fullUsageFor(spec: CommandSpec | undefined): string {
  if (spec === undefined) return ROOT_USAGE;
  return `${spec.name} ${usageFor(spec)}`.trim();
}

export function validateCommand(
  spec: CommandSpec,
  args: readonly unknown[],
  options: Record<string, unknown>,
): void {
  spec.args.forEach((arg, index) => {
    const value = args[index];
    if (value === undefined) return;
    validateValue(arg.name, arg.kind, value, arg.variadic === true);
  });
  for (const option of spec.options) {
    const value = options[option.name];
    if (value === undefined) continue;
    validateValue(
      flagDisplay(option.flags),
      option.kind,
      value,
      option.variadic === true,
    );
  }
  for (const constraint of spec.constraints ?? []) {
    switch (constraint.type) {
      case "exclusive":
        if (
          options[constraint.field] !== undefined &&
          constraint.with.some((field) => options[field] !== undefined)
        )
          throw usageError({
            issue: "invalid_combination",
            field: flagFor(spec, constraint.field),
            hint: constraint.hint,
          });
        break;
      case "requires":
        if (
          options[constraint.field] !== undefined &&
          options[constraint.required] === undefined
        )
          throw usageError({
            issue: "invalid_combination",
            field: flagFor(spec, constraint.field),
            hint: constraint.hint,
          });
        break;
      case "orderedTime":
        if (
          options[constraint.since] !== undefined &&
          options[constraint.until] !== undefined &&
          String(options[constraint.since]) > String(options[constraint.until])
        )
          throw usageError({
            issue: "invalid_combination",
            field: `${flagFor(spec, constraint.since)}, ${flagFor(spec, constraint.until)}`,
            hint: constraint.hint,
          });
        break;
      default:
        assertNever(constraint);
    }
  }
}

export function parseCommandInvocation(
  name: CommandName,
  args: readonly unknown[],
  options: Record<string, unknown>,
  mode: OutputMode,
): CommandInvocation {
  const spec = commandSpecForName(name);
  if (spec === undefined) throw new Error(`Missing command spec: ${name}`);
  const parsed = parseDeclaredInput(spec, args, options);
  // 上述 arity、required/default、值类型与约束均已由同一 spec 证明；
  // 只收窄动态容器，最终 invocation 对象由泛型构造器保持字段关联。
  return invocationFromParsed(name, parsed.args, parsed.options, mode);
}

export function parseDeclaredInput(
  spec: CommandSpec,
  args: readonly unknown[],
  options: Record<string, unknown>,
): {
  readonly args: readonly unknown[];
  readonly options: Record<string, unknown>;
} {
  validateInvocationShape(spec, args, options);
  const materializedOptions: Record<string, unknown> = {};
  for (const option of spec.options) {
    const provided = options[option.name];
    const value =
      provided === undefined && "defaultValue" in option
        ? option.defaultValue
        : provided;
    if (value !== undefined) materializedOptions[option.name] = value;
  }
  validateCommand(spec, args, materializedOptions);
  const parsedArgs = spec.args.map((arg, index) =>
    parseFieldValue(arg.kind, args[index], "variadic" in arg && arg.variadic),
  );
  const parsedOptions: Record<string, unknown> = {};
  for (const option of spec.options) {
    const value = materializedOptions[option.name];
    if (value === undefined) continue;
    parsedOptions[option.name] = parseFieldValue(
      option.kind,
      value,
      "variadic" in option && option.variadic,
    );
  }
  return { args: parsedArgs, options: parsedOptions };
}

function invocationFromParsed(
  name: CommandName,
  args: readonly unknown[],
  options: Record<string, unknown>,
  mode: OutputMode,
): CommandInvocation {
  const typedArgs = <
    N extends CommandName,
  >(): CommandInvocationFor<N>["args"] =>
    args as unknown as CommandInvocationFor<N>["args"];
  const typedOptions = <
    N extends CommandName,
  >(): CommandInvocationFor<N>["options"] => options;
  switch (name) {
    case "retry":
      return {
        command: "retry",
        args: typedArgs<"retry">(),
        options: typedOptions<"retry">(),
        mode,
      };
    case "spawn":
      return {
        command: "spawn",
        args: typedArgs<"spawn">(),
        options: typedOptions<"spawn">(),
        mode,
      };
    case "send":
      return {
        command: "send",
        args: typedArgs<"send">(),
        options: typedOptions<"send">(),
        mode,
      };
    case "wait":
      return {
        command: "wait",
        args: typedArgs<"wait">(),
        options: typedOptions<"wait">(),
        mode,
      };
    case "interrupt":
      return {
        command: "interrupt",
        args: typedArgs<"interrupt">(),
        options: typedOptions<"interrupt">(),
        mode,
      };
    case "kill":
      return {
        command: "kill",
        args: typedArgs<"kill">(),
        options: typedOptions<"kill">(),
        mode,
      };
    case "list":
      return {
        command: "list",
        args: typedArgs<"list">(),
        options: typedOptions<"list">(),
        mode,
      };
    case "attach":
      return {
        command: "attach",
        args: typedArgs<"attach">(),
        options: typedOptions<"attach">(),
        mode,
      };
    case "diagnostics":
      return {
        command: "diagnostics",
        args: typedArgs<"diagnostics">(),
        options: typedOptions<"diagnostics">(),
        mode,
      };
    case "capabilities":
      return {
        command: "capabilities",
        args: typedArgs<"capabilities">(),
        options: typedOptions<"capabilities">(),
        mode,
      };
    case "resolve-permission":
      return {
        command: "resolve-permission",
        args: typedArgs<"resolve-permission">(),
        options: typedOptions<"resolve-permission">(),
        mode,
      };
    default:
      return assertNever(name);
  }
}

function validateInvocationShape(
  spec: CommandSpec,
  args: readonly unknown[],
  options: Record<string, unknown>,
): void {
  if (args.length > spec.args.length) {
    throw usageError({
      issue: "invalid_value",
      field: "arguments",
      detail: "Too many arguments",
      hint: "Remove the extra arguments",
    });
  }
  const knownOptions = new Set([
    ...spec.options.map((option) => option.name),
    "pretty",
  ]);
  for (const name of Object.keys(options)) {
    if (!knownOptions.has(name)) {
      throw usageError({
        issue: "unknown_option",
        value: `--${name}`,
        valid: [
          ...spec.options.map((option) => flagDisplay(option.flags)),
          "--pretty",
        ],
      });
    }
  }
  const missing = missingRequiredUsageError(spec, args, options);
  if (missing !== undefined) throw missing;
}

export function missingRequiredUsageError(
  spec: CommandSpec,
  args: readonly unknown[],
  options: Readonly<Record<string, unknown>>,
): UsageError | undefined {
  const issues: UsageIssue[] = [];
  for (let index = 0; index < spec.args.length; index += 1) {
    const arg = spec.args[index];
    if (arg === undefined) continue;
    const value = args[index];
    if (
      value === undefined ||
      (arg.variadic === true && Array.isArray(value) && value.length === 0)
    ) {
      issues.push(missingIssue("argument", arg.name, arg));
    }
  }
  for (const option of spec.options) {
    if (option.required === true && options[option.name] === undefined) {
      issues.push(missingIssue("option", option.flags, option));
    }
  }
  const [first, ...rest] = issues;
  return first === undefined ? undefined : usageErrors([first, ...rest]);
}

function missingIssue(
  target: "argument" | "option",
  field: string,
  declaration: Pick<CommandArg | CommandOption, "description" | "kind">,
): UsageIssue {
  if (declaration.kind.type === "enum") {
    return {
      issue: "missing_argument",
      target,
      field,
      valid: [...declaration.kind.values],
    };
  }
  return {
    issue: "missing_argument",
    target,
    field,
    hint: valueHint(declaration.kind) ?? declaration.description,
  };
}

function flagFor(spec: CommandSpec, name: string): string {
  return flagDisplay(
    spec.options.find((option) => option.name === name)?.flags ?? `--${name}`,
  );
}

function commandTokenIndex(
  argv: readonly string[],
  rootOptions: boolean,
): number {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") return index + 1;
    if (token === "--pretty" || token === "--version" || token === "-V")
      continue;
    if (rootOptions && token === "-C") {
      index += 1;
      continue;
    }
    if (rootOptions && token.startsWith("-C") && token.length > 2) continue;
    if (token.startsWith("-")) return -1;
    return index;
  }
  return -1;
}

function validateValue(
  field: string,
  kind: ValueKind,
  value: unknown,
  variadic: boolean,
): void {
  if (variadic) {
    if (!Array.isArray(value)) {
      throw usageError({
        issue: "invalid_value",
        field,
        value: String(value),
      });
    }
    for (const item of value) validateValue(field, kind, item, false);
    return;
  }
  switch (kind.type) {
    case "text":
    case "dynamic":
      if (typeof value !== "string")
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
        });
      return;
    case "boolean":
      if (typeof value !== "boolean")
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
        });
      return;
    case "enum": {
      if (typeof value !== "string" || !kind.values.includes(value)) {
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          valid: [...kind.values],
        });
      }
      return;
    }
    case "number": {
      const numeric = Number(value);
      if (
        !Number.isFinite(numeric) ||
        (kind.integer === true && !Number.isInteger(numeric)) ||
        (kind.min !== undefined && numeric < kind.min) ||
        (kind.max !== undefined && numeric > kind.max)
      ) {
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      }
      return;
    }
    case "jsonObject": {
      if (typeof value !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        throw usageError({
          issue: "invalid_value",
          field,
          value,
          hint: kind.hint,
        });
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw usageError({
          issue: "invalid_value",
          field,
          value,
          hint: kind.hint,
        });
      }
      return;
    }
    case "sessionName":
      if (
        typeof value !== "string" ||
        !v.safeParse(sessionNameSchema, value).success
      )
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      return;
    case "sessionId":
      if (
        typeof value !== "string" ||
        !v.safeParse(sessionIdSchema, value).success
      )
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      return;
    case "resumeCursor":
      if (
        typeof value !== "string" ||
        !v.safeParse(resumeCursorSchema, value).success
      )
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      return;
    case "permissionHandle":
      if (
        typeof value !== "string" ||
        !v.safeParse(permissionHandleSchema, value).success
      )
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      return;
    case "permissionId":
      if (
        typeof value !== "string" ||
        !v.safeParse(permissionIdSchema, value).success
      )
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      return;
    case "turnHandle":
      if (
        typeof value !== "string" ||
        !v.safeParse(turnHandleSchema, value).success
      )
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      return;
    case "turnId":
      if (
        typeof value !== "string" ||
        !v.safeParse(turnIdSchema, value).success
      )
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      return;
    case "diagnosticId":
      if (
        typeof value !== "string" ||
        !v.safeParse(diagnosticIdSchema, value).success
      )
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      return;
    case "time":
      if (
        typeof value !== "string" ||
        !v.safeParse(utcMillisecondTimestampSchema, value).success
      )
        throw usageError({
          issue: "invalid_value",
          field,
          value: String(value),
          hint: kind.hint,
        });
      return;
    default:
      return assertNever(kind);
  }
}

function parseFieldValue(
  kind: ValueKind,
  value: unknown,
  variadic: boolean,
): unknown {
  if (variadic) {
    if (!Array.isArray(value)) {
      throw new Error("Validated variadic command value is not an array");
    }
    return value.map((item) => parseFieldValue(kind, item, false));
  }
  switch (kind.type) {
    case "text":
    case "dynamic":
    case "boolean":
    case "enum":
    case "time":
      return value;
    case "number":
      return Number(value);
    case "jsonObject": {
      if (typeof value !== "string") return value;
      const parsed: unknown = JSON.parse(value);
      return parsed;
    }
    case "sessionName":
      return v.parse(sessionNameSchema, value);
    case "sessionId":
      return v.parse(sessionIdSchema, value);
    case "turnHandle":
      return decodeTurnHandle(String(value));
    case "turnId":
      return v.parse(turnIdSchema, value);
    case "resumeCursor":
      return v.parse(resumeCursorSchema, value);
    case "permissionHandle":
      return decodePermissionHandle(String(value));
    case "permissionId":
      return v.parse(permissionIdSchema, value);
    case "diagnosticId":
      return v.parse(diagnosticIdSchema, value);
    default:
      return assertNever(kind);
  }
}

export function valueHint(kind: ValueKind): string | undefined {
  switch (kind.type) {
    case "text":
    case "boolean":
      return undefined;
    case "enum":
      return `Allowed: ${kind.values.join(", ")}`;
    case "sessionName":
    case "sessionId":
    case "turnId":
    case "turnHandle":
    case "permissionId":
    case "permissionHandle":
    case "resumeCursor":
    case "diagnosticId":
    case "time":
    case "number":
    case "jsonObject":
    case "dynamic":
      return kind.hint;
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command specification variant: ${String(value)}`);
}
