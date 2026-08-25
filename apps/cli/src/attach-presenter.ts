import type {
  AttachResult,
  DomainEvent,
  ProtocolNotification,
} from "@reins/protocol";

import { printNotification } from "./output.ts";

export type PrettyAttachPresenter = {
  bufferInitial(notification: ProtocolNotification): void;
  flushInitial(prefixes: AttachResult["replayPrefixes"]): void;
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
  return `${event.turnId}\0${event.messageId}`;
}

function turnPrefix(event: { sessionId: string; turnId: string }): string {
  return `${event.turnId}\0`;
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
    flushInitial(prefixes) {
      const initialDeltaKeys = new Set<string>();
      for (const notification of batch) {
        if (notification.method !== "event") continue;
        const event = notification.params;
        if (event.type === "text.delta") {
          initialDeltaKeys.add(messageIdentity(event));
        }
      }
      const prefixByIdentity = new Map(
        prefixes.map((prefix) => [
          `${prefix.turnId}\0${prefix.messageId}`,
          prefix.prefix,
        ]),
      );
      const seeded = new Set<string>();
      for (const [key, prefix] of prefixByIdentity) {
        if (!initialDeltaKeys.has(key)) {
          process.stdout.write(prefix);
          messages.set(key, { streamed: prefix, snapshotSeen: false });
          seeded.add(key);
        }
      }
      for (const notification of batch.splice(0)) {
        if (notification.method === "event") {
          const event = notification.params;
          if (event.type === "text.delta") {
            const key = messageIdentity(event);
            const prefix = prefixByIdentity.get(key);
            if (prefix !== undefined && !seeded.has(key)) {
              process.stdout.write(prefix);
              messages.set(key, { streamed: prefix, snapshotSeen: false });
              seeded.add(key);
            }
          }
          presentEvent(event);
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
