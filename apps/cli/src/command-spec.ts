import { PUBLISHER_CAPABILITIES } from "@reins/workspace-protocol";

import {
  usageError,
  usageErrors,
  type UsageError,
  type UsageIssue,
} from "./errors.ts";

export type ValueKind =
  | { readonly type: "text" }
  | { readonly type: "boolean" }
  | { readonly type: "enum"; readonly values: readonly string[] };

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
};

export const ROOT_USAGE = "[options] <command>";

export function defineCommand<const S extends CommandSpec>(spec: S): S {
  return spec;
}

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

export const publisherGroupSpec: CommandSpec = {
  name: "",
  description: "Publisher operations",
  args: [],
  options: [],
  usage: "[options] <command>",
  children: publisherCommandSpecs.map((spec) => spec.name),
};

export function publisherCommandSpecForToken(
  argv: readonly string[],
): CommandSpec | undefined {
  const commandIndex = commandTokenIndex(argv);
  if (commandIndex === -1) return undefined;
  const commandToken = argv[commandIndex];
  return commandToken === undefined
    ? undefined
    : publisherCommandSpecs.find((spec) => spec.name === commandToken);
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

function commandTokenIndex(argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") return index + 1;
    if (token === "--pretty" || token === "--version" || token === "-V")
      continue;
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
    case "boolean":
    case "enum":
      return value;
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
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command specification variant: ${String(value)}`);
}
