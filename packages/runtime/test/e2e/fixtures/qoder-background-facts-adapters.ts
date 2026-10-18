import { readFile } from "node:fs/promises";

import { createQoderDriver } from "@reins/qoder";
import type { QoderQuery, QoderSdk } from "@reins/qoder";
import { createQoderFixtureSdk } from "@reins/qoder/testing";

const sessionId = "00000000-0000-4000-8000-000000000001";
const messages = [
  {
    type: "assistant",
    message: {
      id: "agent-message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "agent-tool-use",
          name: "Agent",
          input: { description: "Read file contents", prompt: "Read it" },
        },
      ],
      model: "qwen",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "agent-message",
    session_id: sessionId,
  },
  {
    type: "system",
    subtype: "task_started",
    task_id: "qoder-task-1",
    tool_use_id: "agent-tool-use",
    description: "Read file contents",
    uuid: "task-started",
    session_id: sessionId,
  },
  {
    type: "system",
    subtype: "task_progress",
    task_id: "qoder-task-1",
    tool_use_id: "agent-tool-use",
    description: "count-me.txt",
    uuid: "task-progress",
    session_id: sessionId,
  },
  {
    type: "assistant",
    message: {
      id: "agent-reply",
      role: "assistant",
      content: [{ type: "text", text: "已启动后台读取。" }],
      model: "qwen",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "agent-reply",
    session_id: sessionId,
  },
  {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "已启动后台读取。",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "",
      input_tokens: 0,
      iterations: [],
      output_tokens: 0,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "",
      speed: "",
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "result",
    session_id: sessionId,
  },
] satisfies Parameters<typeof createQoderFixtureSdk>[0];

const fixtureSdk = createQoderFixtureSdk(messages);
const lateNotification = {
  type: "system",
  subtype: "task_notification",
  task_id: "qoder-task-1",
  tool_use_id: "agent-tool-use",
  status: "completed",
  output_file: "",
  summary: 'Agent "Read file contents" finished',
  uuid: "task-completed",
  session_id: sessionId,
} satisfies Parameters<typeof createQoderFixtureSdk>[0][number];

const sdk: QoderSdk = {
  getAvailableModels: () => fixtureSdk.getAvailableModels(),
  query(params) {
    let gatePath: string | undefined;
    const prompt = (async function* () {
      for await (const input of params.prompt) {
        if (typeof input.message.content === "string") {
          const value = JSON.parse(input.message.content) as {
            gatePath?: unknown;
          };
          if (typeof value.gatePath === "string") gatePath = value.gatePath;
        }
        yield input;
      }
    })();
    const query = fixtureSdk.query({ ...params, prompt });
    const queryWithLateActivity: QoderQuery = {
      [Symbol.asyncIterator]: async function* () {
        for await (const message of query) {
          yield message;
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "system" &&
            "subtype" in message &&
            message.subtype === "task_progress"
          ) {
            if (gatePath === undefined)
              throw new Error("Qoder facts fixture omitted its release gate");
            for (;;) {
              try {
                await readFile(gatePath, "utf8");
                break;
              } catch {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }
          }
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "command_lifecycle" &&
            "state" in message &&
            message.state === "completed"
          )
            yield lateNotification;
        }
      },
      initializationResult: () => query.initializationResult(),
      interrupt: () => query.interrupt(),
      cancelAsyncMessage: (uuid) => query.cancelAsyncMessage(uuid),
      close: () => query.close(),
    };
    return queryWithLateActivity;
  },
};

export default {
  qoder: {
    driverFactory: createQoderDriver({ sdk }),
    modelCatalog: async () => ({ harness: "qoder", models: [] }),
  },
};
