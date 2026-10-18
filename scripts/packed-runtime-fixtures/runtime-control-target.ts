import { resolveControlRuntimeTarget } from "@ykdz/reins/control-entry";

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
};

const target = await resolveControlRuntimeTarget({ env: process.env });
process.stdout.write(`${JSON.stringify(target)}\n`);
