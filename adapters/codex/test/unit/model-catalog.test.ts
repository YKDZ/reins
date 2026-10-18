import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { DriverDiagnosticFact, SessionId, TurnId } from "@reins/protocol";
import { makeDiagnosticId } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createCodexDriver } from "#/codex-driver";
import { createCodexModelCatalog } from "#/model-catalog";
import {
  createCodexTransport,
  ProtocolBoundaryError,
  type CodexChild,
} from "#/transport";

import { createFakeTransport } from "../helpers/fake-transport.ts";

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Codex 模型目录", () => {
  test("能力查询与 worker 共用冷 HOME 首次 initialize 协调", async () => {
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = `/tmp/reins-codex-model-catalog-${randomUUID()}`;
    const workerFake = createFakeTransport();
    const modelCatalogFake = createFakeTransport();
    const workerInitialize = deferred<Record<string, never>>();
    workerFake.controls.setResponse("initialize", workerInitialize.promise);
    let workerStarts = 0;
    let modelCatalogStarts = 0;
    workerFake.transport.start = () => {
      workerStarts += 1;
    };
    modelCatalogFake.transport.start = () => {
      modelCatalogStarts += 1;
    };
    const sessionId = "session:capabilitiesworker:1" as SessionId;
    const worker = createCodexDriver({
      transportFactory: () => workerFake.transport,
    })({
      emit: () => undefined,
      diagnostics: async () => undefined,
    });
    let modelCatalogPromise: Promise<unknown> | undefined;

    try {
      worker.start({
        sessionId,
        turnId: "t1" as TurnId,
        harness: "codex",
        message: "caller task",
        cwd: "/tmp/demo",
      });
      await flush();
      expect(workerStarts).toBe(1);

      modelCatalogPromise = createCodexModelCatalog({
        transportFactory: () => modelCatalogFake.transport,
      })();
      await flush();
      expect(modelCatalogStarts).toBe(0);
      expect(modelCatalogFake.controls.requests()).toEqual([]);

      workerInitialize.resolve({});
      await flush();
      expect(modelCatalogStarts).toBe(1);
      await expect(modelCatalogPromise).resolves.toEqual({
        harness: "codex",
        models: [],
      });
    } finally {
      workerInitialize.resolve({});
      if (modelCatalogPromise !== undefined)
        await modelCatalogPromise.catch(() => {});
      await worker.terminate(sessionId);
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("model/list 实时查询并映射为模型目录", async () => {
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

    const modelCatalog = await createCodexModelCatalog({
      transportFactory: () => transport,
    })();

    expect(controls.requests().map((entry) => entry.method)).toEqual([
      "initialize",
      "model/list",
    ]);
    expect(controls.closed()).toBe(true);
    expect(modelCatalog).toEqual({
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
      createCodexModelCatalog({ transportFactory: () => failingTransport })(),
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
    const diagnosticId = makeDiagnosticId("modelcatalog", "98");
    const query = createCodexModelCatalog({
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
