import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: { input?: { text: string }[] };
  };
  appendFileSync(
    process.env.REINS_W05_NATIVE_LOG!,
    JSON.stringify(request) + "\n",
  );
  if (request.id === undefined) continue;
  const result =
    request.method === "thread/start"
      ? { thread: { id: "native-thread" } }
      : request.method === "turn/start"
        ? { turn: { id: "native-turn" } }
        : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  if (
    request.method === "turn/start" &&
    ["permission", "cancel-only", "resolved-permission"].includes(
      request.params?.input?.[0]?.text ?? "",
    )
  )
    process.stdout.write(
      JSON.stringify({
        id: 700,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "native-thread",
          turnId: "native-turn",
          itemId: "command",
          command: "caller-command",
          availableDecisions:
            request.params?.input?.[0]?.text === "cancel-only"
              ? ["cancel"]
              : ["accept", "cancel"],
        },
      }) + "\n",
    );
  if (
    request.method === "turn/start" &&
    request.params?.input?.[0]?.text === "resolved-permission"
  )
    process.stdout.write(
      JSON.stringify({
        method: "serverRequest/resolved",
        params: { requestId: 700 },
      }) + "\n",
    );
}
