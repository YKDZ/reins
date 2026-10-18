import {
  HarnessModelCatalogFailure,
  noopDiagnosticSink,
  type AdapterDiagnosticSink,
} from "@reins/adapter-kit";
import type { HarnessFailure, HarnessModelCatalog } from "@reins/protocol";
import { makeTextEvidence } from "@reins/protocol";
import * as v from "valibot";

import { DshHostClient, DshHostRequestError } from "./dsh-host-client.ts";
import { failureFromSafeFacts, safeFailureFrom } from "./dsh-host-protocol.ts";

const DSH_MODEL_PREFIX = "dsh1_";
const dshModelRouteSchema = v.strictObject({
  provider: v.pipe(v.string(), v.minLength(1)),
  model: v.pipe(v.string(), v.minLength(1)),
});

export function encodeDshModelId(provider: string, model: string): string {
  const route = v.parse(dshModelRouteSchema, { provider, model });
  return `${DSH_MODEL_PREFIX}${Buffer.from(JSON.stringify(route)).toString("base64url")}`;
}

export function decodeDshModelId(value: string): {
  readonly provider: string;
  readonly model: string;
} {
  if (!value.startsWith(DSH_MODEL_PREFIX))
    throw new Error("Invalid DSH model identifier");
  const encoded = value.slice(DSH_MODEL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded))
    throw new Error("Invalid DSH model identifier");
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded)
    throw new Error("Invalid DSH model identifier");
  return v.parse(dshModelRouteSchema, JSON.parse(decoded));
}

function diagnosticText(error: DshHostRequestError | undefined): string {
  if (error === undefined) return "DSH model catalog query failed";
  const details = [
    error.failure?.code,
    error.failure?.status === undefined
      ? undefined
      : `HTTP ${error.failure.status}`,
  ].filter((value): value is string => value !== undefined);
  return details.length === 0
    ? "DSH model catalog query failed"
    : `DSH model catalog query failed (${details.join(", ")})`;
}

export function createDshModelCatalog(): (
  diagnostics?: AdapterDiagnosticSink,
) => Promise<HarnessModelCatalog> {
  return async (diagnostics = noopDiagnosticSink) => {
    let host: DshHostClient | undefined;
    let catalog: HarnessModelCatalog | undefined;
    let failureError: unknown;
    try {
      host = new DshHostClient({ cwd: process.cwd() });
      await host.readyHost();
      const response = await host.request({ type: "catalog" });
      if (response.type !== "catalog")
        throw new Error(
          "The official DSH returned an unexpected model catalog response",
        );
      catalog = {
        harness: "dsh",
        models: response.models.map((model) => ({
          id: encodeDshModelId(model.provider, model.model),
          displayName: model.displayName,
          reasoningEfforts: [...model.reasoningEfforts],
        })),
      };
    } catch (error) {
      failureError = error;
    }
    if (host !== undefined) {
      try {
        await host.close();
      } catch (error) {
        failureError ??= error;
      }
    }
    if (failureError !== undefined) {
      const hostFailure =
        failureError instanceof DshHostRequestError ? failureError : undefined;
      const facts = hostFailure?.failure ?? safeFailureFrom(failureError);
      const failure: HarnessFailure = failureFromSafeFacts(facts);
      const diagnosticId = await Promise.resolve()
        .then(() =>
          diagnostics({
            kind: "request_failure",
            operation: "model_catalog",
            stage: "query",
            reason: "upstream_error",
            message: makeTextEvidence(diagnosticText(hostFailure)),
          }),
        )
        .catch(() => undefined);
      throw new HarnessModelCatalogFailure(failure, diagnosticId);
    }
    if (catalog === undefined)
      throw new HarnessModelCatalogFailure({
        failureCategory: "unclassified",
        retryDisposition: "unknown",
      });
    return catalog;
  };
}
