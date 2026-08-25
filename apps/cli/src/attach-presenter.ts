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
  boundaryUncertain: boolean;
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

  const holdUncertainDelta = (
    event: Extract<DomainEvent, { type: "text.delta" }>,
  ): void => {
    const key = messageIdentity(event);
    const state = messages.get(key) ?? {
      streamed: "",
      snapshotSeen: false,
      boundaryUncertain: true,
    };
    state.streamed += event.delta;
    messages.set(key, state);
  };

  const flushUncertain = (matches: (key: string) => boolean): void => {
    for (const [key, state] of messages) {
      if (!matches(key) || !state.boundaryUncertain || state.snapshotSeen) {
        continue;
      }
      if (state.streamed.length > 0) {
        process.stdout.write(state.streamed);
        completeStreamedLine(state.streamed);
      }
      state.boundaryUncertain = false;
      state.snapshotSeen = true;
    }
  };

  const presentEvent = (event: DomainEvent): void => {
    if (event.type === "text.delta") {
      const key = messageIdentity(event);
      const state = messages.get(key) ?? {
        streamed: "",
        snapshotSeen: false,
        boundaryUncertain: false,
      };
      if (!state.snapshotSeen) {
        if (!state.boundaryUncertain) process.stdout.write(event.delta);
        state.streamed += event.delta;
      }
      messages.set(key, state);
      return;
    }
    if (event.type === "message") {
      const key = messageIdentity(event);
      const state = messages.get(key);
      if (state?.snapshotSeen === true) return;
      if (state?.boundaryUncertain === true) {
        writeSnapshot(event);
        messages.set(key, {
          streamed: event.content,
          snapshotSeen: true,
          boundaryUncertain: false,
        });
        return;
      }
      if (state !== undefined && state.streamed === event.content) {
        completeStreamedLine(state.streamed);
        state.snapshotSeen = true;
        return;
      }
      writeSnapshot(event);
      messages.set(key, {
        streamed: event.content,
        snapshotSeen: true,
        boundaryUncertain: false,
      });
      return;
    }
    if (event.type === "turn.completed") {
      const turnPrefix = `${event.sessionId}\0${event.turnId}\0`;
      flushUncertain((key) => key.startsWith(turnPrefix));
      printNotification("event", event, "pretty");
      for (const key of messages.keys()) {
        if (key.startsWith(turnPrefix)) messages.delete(key);
      }
      return;
    }
    printNotification("event", event, "pretty");
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
            !snapshots.has(messageIdentity(event))
          ) {
            holdUncertainDelta(event);
            continue;
          }
          if (
            event.type === "text.delta" &&
            !complete.has(messageIdentity(event))
          ) {
            continue;
          }
          presentEvent(event);
        } else {
          flushUncertain(() => true);
          printNotification(notification.method, notification.params, "pretty");
        }
      }
    },
    present(notification) {
      if (notification.method === "event") presentEvent(notification.params);
      else {
        flushUncertain(() => true);
        printNotification(notification.method, notification.params, "pretty");
      }
    },
    clear() {
      initial.length = 0;
      messages.clear();
    },
  };
}
