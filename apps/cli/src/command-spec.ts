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

export const workspaceCommandSpecs: readonly CommandSpec[] = [
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
