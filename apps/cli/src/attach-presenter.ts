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
  const initial: ProtocolNotification[] = [];
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
      const turnPrefix = `${event.sessionId}\0${event.turnId}\0`;
      for (const key of messages.keys()) {
        if (key.startsWith(turnPrefix)) messages.delete(key);
      }
    }
  };

  return {
    bufferInitial(notification) {
      initial.push(notification);
    },
    flushInitial() {
      const deltaContent = new Map<string, string>();
      const snapshots = new Map<string, string>();
      for (const notification of initial) {
        if (notification.method !== "event") continue;
        const event = notification.params;
        if (event.type === "text.delta") {
          const key = messageIdentity(event);
          deltaContent.set(key, `${deltaContent.get(key) ?? ""}${event.delta}`);
        } else if (event.type === "message") {
          snapshots.set(messageIdentity(event), event.content);
        }
      }
      const complete = new Set(
        [...snapshots].flatMap(([key, content]) =>
          deltaContent.get(key) === content ? [key] : [],
        ),
      );
      for (const notification of initial.splice(0)) {
        if (notification.method === "event") {
          const event = notification.params;
          if (
            event.type === "text.delta" &&
            snapshots.has(messageIdentity(event)) &&
            !complete.has(messageIdentity(event))
          ) {
            continue;
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
      initial.length = 0;
      messages.clear();
    },
  };
}
