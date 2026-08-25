import type { DomainEvent, ProtocolNotification } from "@reins/protocol";

import { printNotification } from "./output.ts";

export type PrettyAttachPresenter = {
  bufferInitial(notification: ProtocolNotification): void;
  flushInitial(): void;
  present(notification: ProtocolNotification): void;
  clear(): void;
};

type MessageState = {
  streamed: string;
  snapshotSeen: boolean;
};

function messageIdentity(
  event: Extract<DomainEvent, { type: "text.delta" | "message" }>,
): string {
  return `${event.sessionId}\0${event.turnId}\0${event.messageId}`;
}

function turnPrefix(event: { sessionId: string; turnId: string }): string {
  return `${event.sessionId}\0${event.turnId}\0`;
}

function writeSnapshot(event: Extract<DomainEvent, { type: "message" }>): void {
  process.stdout.write(
    `${event.role === "worker" ? "worker" : "caller"}: ${event.content}`,
  );
  completeStreamedLine(event.content);
}

function completeStreamedLine(content: string): void {
  if (!content.endsWith("\n")) process.stdout.write("\n");
}

export function createPrettyAttachPresenter(): PrettyAttachPresenter {
  const batch: ProtocolNotification[] = [];
  const messages = new Map<string, MessageState>();

  const presentEvent = (event: DomainEvent): void => {
    if (event.type === "text.delta") {
      const key = messageIdentity(event);
      const state = messages.get(key) ?? { streamed: "", snapshotSeen: false };
      if (!state.snapshotSeen) {
        process.stdout.write(event.delta);
        state.streamed += event.delta;
      }
      messages.set(key, state);
      return;
    }
    if (event.type === "message") {
      const key = messageIdentity(event);
      const state = messages.get(key);
      if (state?.snapshotSeen === true) return;
      if (state !== undefined && state.streamed === event.content) {
        completeStreamedLine(state.streamed);
        state.snapshotSeen = true;
        return;
      }
      writeSnapshot(event);
      messages.set(key, { streamed: event.content, snapshotSeen: true });
      return;
    }
    printNotification("event", event, "pretty");
    if (event.type === "turn.completed") {
      const prefix = turnPrefix(event);
      for (const key of messages.keys()) {
        if (key.startsWith(prefix)) messages.delete(key);
      }
    }
  };

  return {
    bufferInitial(notification) {
      batch.push(notification);
    },
    flushInitial() {
      for (const notification of batch.splice(0)) {
        if (notification.method === "event") {
          presentEvent(notification.params);
        } else {
          printNotification(notification.method, notification.params, "pretty");
        }
      }
    },
    present(notification) {
      if (notification.method === "event") presentEvent(notification.params);
      else
        printNotification(notification.method, notification.params, "pretty");
    },
    clear() {
      batch.length = 0;
      messages.clear();
    },
  };
}
