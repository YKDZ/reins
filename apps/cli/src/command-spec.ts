import type { Command } from "commander";

import { usageError } from "./errors.ts";
import type { OutputMode } from "./output.ts";

export type ValueKind =
  | { readonly type: "text" }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | {
      readonly type: "number";
      readonly integer?: boolean;
      readonly min?: number;
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
};

export type RunContext<
  A extends readonly unknown[] = readonly unknown[],
  O extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly args: A;
  readonly options: O;
  readonly mode: OutputMode;
  readonly program: Command;
};

export const ROOT_USAGE = "[options] <command>";

export const STOP_REASONS = [
  "end_turn",
  "cancelled",
  "failed",
  "killed",
] as const;

export function defineCommand<S extends CommandSpec>(spec: S): S {
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
        description: "working directory",
        kind: { type: "text" },
      },
      {
        name: "authorizationMode",
        flags: "--authorization-mode <mode>",
        description: "interactive | allow-all (default: allow-all)",
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
        description: "caller-authored session name",
        kind: { type: "text" },
      },
      {
        name: "meta",
        flags: "--meta <json>",
        description: "arbitrary JSON metadata",
        kind: { type: "jsonObject", hint: "Expected a JSON object" },
      },
    ],
  }),
  defineCommand({
    name: "send",
    description: "Send a message to a session",
    args: [
      { name: "sessionId", description: "session id", kind: { type: "text" } },
      {
        name: "message",
        variadic: true,
        description: "message text",
        kind: { type: "text" },
      },
    ],
    options: [],
  }),
  defineCommand({
    name: "wait",
    description: "Wait for turns to complete",
    args: [
      {
        name: "ids",
        variadic: true,
        description: "session ids",
        kind: { type: "text" },
      },
    ],
    options: [
      {
        name: "timeout",
        flags: "--timeout <ms>",
        defaultValue: "60000",
        description: "timeout in milliseconds",
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
    description: "Interrupt running turns",
    args: [
      {
        name: "ids",
        variadic: true,
        description: "session ids",
        kind: { type: "text" },
      },
    ],
    options: [],
  }),
  defineCommand({
    name: "kill",
    description: "Kill sessions permanently",
    args: [
      {
        name: "ids",
        variadic: true,
        description: "session ids",
        kind: { type: "text" },
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
        kind: { type: "text" },
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
    description:
      "Stream a session's full event transcript (diagnostic view; use run for the compact result)",
    args: [
      { name: "sessionId", description: "session id", kind: { type: "text" } },
    ],
    options: [
      {
        name: "replay",
        flags: "--replay <n>",
        description: "number of recent events to replay",
        kind: {
          type: "number",
          integer: true,
          min: 0,
          hint: "Expected a non-negative integer",
        },
      },
      {
        name: "exitOn",
        flags: "--exit-on <reasons...>",
        variadic: true,
        description: "stop reasons to exit on",
        kind: { type: "enum", values: STOP_REASONS },
      },
    ],
  }),
  defineCommand({
    name: "run",
    description:
      "Run a worker session to completion and return the final result (agent-facing one-shot; use attach for live transcript)",
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
        description: "working directory",
        kind: { type: "text" },
      },
      {
        name: "authorizationMode",
        flags: "--authorization-mode <mode>",
        description: "interactive | allow-all (default: allow-all)",
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
        description: "caller-authored session name",
        kind: { type: "text" },
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
    description: "Resolve a pending permission request",
    args: [
      { name: "sessionId", description: "session id", kind: { type: "text" } },
      {
        name: "permissionId",
        description: "permission request id",
        kind: { type: "text" },
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
] as const satisfies readonly CommandSpec[];

export const commandSpecs: readonly CommandSpec[] = commandSpecData;

export type CommandName = (typeof commandSpecData)[number]["name"];

export type RunHandler = (ctx: RunContext) => Promise<void>;

export function commandSpecForName(name: string): CommandSpec | undefined {
  return commandSpecs.find((spec) => spec.name === name);
}

export function commandSpecForToken(
  argv: readonly string[],
): CommandSpec | undefined {
  for (const token of argv) {
    if (token.startsWith("-")) continue;
    const spec = commandSpecForName(token);
    if (spec !== undefined) return spec;
  }
  return undefined;
}

export function flagDisplay(flags: string): string {
  const first = flags.split(/\s+/u)[0];
  return first === undefined ? flags : first;
}

export function usageFor(spec: CommandSpec | undefined): string {
  if (spec === undefined) return ROOT_USAGE;
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
}

function validateValue(
  field: string,
  kind: ValueKind,
  value: unknown,
  variadic: boolean,
): void {
  if (kind.type === "enum") {
    if (variadic && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== "string" || !kind.values.includes(item)) {
          throw usageError("invalid_value", {
            field,
            value: String(item),
            valid: [...kind.values],
          });
        }
      }
      return;
    }
    if (typeof value !== "string" || !kind.values.includes(value)) {
      throw usageError("invalid_value", {
        field,
        value: String(value),
        valid: [...kind.values],
      });
    }
    return;
  }
  if (kind.type === "number") {
    const numeric = Number(value);
    if (
      !Number.isFinite(numeric) ||
      (kind.integer === true && !Number.isInteger(numeric)) ||
      (kind.min !== undefined && numeric < kind.min)
    ) {
      throw usageError("invalid_value", {
        field,
        value: String(value),
        hint: kind.hint,
      });
    }
    return;
  }
  if (kind.type === "jsonObject") {
    if (typeof value !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw usageError("invalid_value", {
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
      throw usageError("invalid_value", {
        field,
        value,
        hint: kind.hint,
      });
    }
  }
}
