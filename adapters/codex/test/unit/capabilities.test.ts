import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { DiagnosticId, DriverDiagnosticFact } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createCodexCapabilities } from "#/capabilities";
import {
  createCodexTransport,
  ProtocolBoundaryError,
  type CodexChild,
} from "#/transport";

import { createFakeTransport } from "../helpers/fake-transport.ts";

describe("codex capabilities", () => {
  test("model/list 实时查询并映射为能力矩阵", async () => {
    const { transport, controls } = createFakeTransport();
    controls.setResponse("model/list", {
      data: [
        {
          model: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Codex Spark",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "high" },
          ],
        },
        {
          model: "hidden-model",
          displayName: "Hidden",
          hidden: true,
          supportedReasoningEfforts: [],
        },
      ],
    });

    const capability = await createCodexCapabilities({
      transportFactory: () => transport,
    })();

    expect(controls.requests().map((entry) => entry.method)).toEqual([
      "initialize",
      "model/list",
    ]);
    expect(controls.closed()).toBe(true);
    expect(capability).toEqual({
      harness: "codex",
      models: [
        {
          id: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Codex Spark",
          reasoningEfforts: ["low", "high"],
        },
      ],
    });
  });

  test("model/list 失败时错误上抛，由 daemon 归入失败面", async () => {
    const { transport, controls } = createFakeTransport();
    const failingTransport = {
      ...transport,
      request: async () => {
        throw new Error("app-server 不可用");
      },
    };
    await expect(
      createCodexCapabilities({ transportFactory: () => failingTransport })(),
    ).rejects.toThrow("app-server 不可用");
    expect(controls.closed()).toBe(true);
  });

  test("非法 model/list 结果在 transport 记录后携带已接受的 DiagnosticId 上抛", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const emitter = new EventEmitter();
    const child: CodexChild = {
      stdin,
      stdout,
      on: (event, listener) => emitter.on(event, listener),
      kill: () => {
        emitter.emit("exit");
        stdout.end();
        return true;
      },
    };
    let outbound = "";
    stdin.on("data", (chunk) => {
      outbound += String(chunk);
      for (;;) {
        const newline = outbound.indexOf("\n");
        if (newline < 0) break;
        const request = JSON.parse(outbound.slice(0, newline)) as {
          id?: number;
          method?: string;
        };
        outbound = outbound.slice(newline + 1);
        if (request.id === undefined) continue;
        const result =
          request.method === "model/list"
            ? { data: [{ model: "broken" }] }
            : {};
        stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
    const diagnostics: DriverDiagnosticFact[] = [];
    const diagnosticId = "d1-098" as DiagnosticId;
    const query = createCodexCapabilities({
      transportFactory: (options) =>
        createCodexTransport({ ...options, spawnChild: () => child }),
    });

    const error = await query(async (input) => {
      diagnostics.push(input);
      return diagnosticId;
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProtocolBoundaryError);
    expect(error).toMatchObject({ alreadyDiagnosed: true, diagnosticId });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "protocol_violation",
        operation: "validate_worker_response",
        reason: "invalid_shape",
      }),
    ]);
  });
});
