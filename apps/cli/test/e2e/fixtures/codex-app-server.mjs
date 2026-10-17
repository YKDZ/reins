#!/usr/bin/env node

import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let threadSequence = 0;
let turnSequence = 0;

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;

  if (request.method === "model/list") {
    respond(request.id, {
      data: [
        {
          model: "fixture-model",
          displayName: "Fixture model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "high" },
          ],
        },
      ],
    });
    return;
  }
  if (request.method === "thread/start") {
    threadSequence += 1;
    respond(request.id, { thread: { id: `fixture-thread-${threadSequence}` } });
    return;
  }
  if (request.method === "turn/start") {
    turnSequence += 1;
    respond(request.id, { turn: { id: `fixture-turn-${turnSequence}` } });
    return;
  }
  respond(request.id, {});
});
