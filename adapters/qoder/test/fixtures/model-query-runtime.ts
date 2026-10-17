import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const directory = process.env.QODER_MODEL_QUERY_DIR;
if (directory === undefined) throw new Error("missing model query directory");

function record(event: string): void {
  appendFileSync(`${directory}/events.jsonl`, `${event}\n`);
}

for await (const line of createInterface({ input: process.stdin })) {
  const message: unknown = JSON.parse(line);
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "control_request" ||
    !("request_id" in message) ||
    typeof message.request_id !== "string" ||
    !("request" in message) ||
    typeof message.request !== "object" ||
    message.request === null
  ) {
    continue;
  }

  const request = message.request as Record<string, unknown>;
  let response: Record<string, unknown> = {};
  let error: string | undefined;
  if (request.type === "initialize") {
    record("initialize_request");
    response = {
      commands: [],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [],
      account: {},
      capabilities: ["interrupt_receipt_v1"],
    };
  } else if (request.subtype === "get_models") {
    record("get_models_request");
    if (process.env.QODER_MODEL_QUERY_MODE === "reject") {
      error = "fixture model lookup failure";
    } else {
      response = {
        models: [
          {
            value: "fixture-model",
            displayName: "Fixture model",
            description: "Local control fixture",
          },
        ],
      };
    }
  }

  const responseLine = `${JSON.stringify({
    type: "control_response",
    response: {
      ...(error === undefined
        ? { subtype: "success", response }
        : { subtype: "error", error }),
      request_id: message.request_id,
    },
  })}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(responseLine, (writeError) => {
      if (writeError !== null && writeError !== undefined) reject(writeError);
      else resolve();
    });
  });
  if (request.subtype === "get_models") record("get_models_response");
}

record("stdin_eof");
