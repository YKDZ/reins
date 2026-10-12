import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";

export function standardSchema<
  T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: T, ignoreActions: string[] = []) {
  const converted = toStandardJsonSchema(schema);
  const adapted: typeof converted = {
    "~standard": {
      ...converted["~standard"],
      jsonSchema: {
        input: (options) =>
          converted["~standard"].jsonSchema.input({
            ...options,
            libraryOptions: { ...options.libraryOptions, ignoreActions },
          }),
        output: (options) =>
          converted["~standard"].jsonSchema.output({
            ...options,
            libraryOptions: { ...options.libraryOptions, ignoreActions },
          }),
      },
      validate(value) {
        const result = converted["~standard"].validate(value);
        if (result instanceof Promise)
          return result.then((resolved) =>
            resolved.issues === undefined
              ? resolved
              : { issues: resolved.issues },
          );
        return result.issues === undefined ? result : { issues: result.issues };
      },
    },
  };
  return adapted;
}
