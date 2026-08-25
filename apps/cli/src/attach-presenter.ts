import type { DomainEvent, ProtocolNotification } from "@reins/protocol";

import { printNotification } from "./output.ts";

export type PrettyAttachPresenter = {
  bufferInitial(notification: ProtocolNotification): void;
  flushInitial(): void;
  present(notification: ProtocolNotification): void;
  isDeferring(): boolean;
  clear(): void;
};

type MessageState = {
  streamed: string;
  snapshotSeen: boolean;
};

type UncertainIdentity = {
  readonly turnPrefix: string;
  closed: boolean;
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
  const uncertain = new Map<string, UncertainIdentity>();
  let deferring = false;

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

  const closeUncertainties = (notification: ProtocolNotification): void => {
    if (notification.method === "attach.ended") {
      for (const identity of uncertain.values()) identity.closed = true;
      return;
    }
    const event = notification.params;
    if (event.type === "message") {
      const identity = uncertain.get(messageIdentity(event));
      if (identity !== undefined) identity.closed = true;
      return;
    }
    if (event.type === "turn.completed") {
      const prefix = turnPrefix(event);
      for (const identity of uncertain.values()) {
        if (identity.turnPrefix === prefix) identity.closed = true;
      }
    }
  };

  const renderBatch = (): void => {
    const deltaContent = new Map<string, string>();
    const snapshots = new Map<string, string>();
    for (const notification of batch) {
      if (notification.method !== "event") continue;
      const event = notification.params;
      if (event.type === "text.delta") {
        const key = messageIdentity(event);
        deltaContent.set(key, `${deltaContent.get(key) ?? ""}${event.delta}`);
      } else if (event.type === "message") {
        snapshots.set(messageIdentity(event), event.content);
      }
    }
    const emittedUncertainTails = new Set<string>();
    for (const notification of batch.splice(0)) {
      if (notification.method !== "event") {
        printNotification(notification.method, notification.params, "pretty");
        continue;
      }
      const event = notification.params;
      if (event.type === "text.delta") {
        const key = messageIdentity(event);
        if (uncertain.has(key)) {
          if (!snapshots.has(key) && !emittedUncertainTails.has(key)) {
            const observed = deltaContent.get(key) ?? "";
            if (observed.length > 0) {
              process.stdout.write(observed);
              completeStreamedLine(observed);
            }
            emittedUncertainTails.add(key);
          }
          continue;
        }
        const snapshot = snapshots.get(key);
        if (snapshot !== undefined && deltaContent.get(key) !== snapshot) {
          continue;
        }
      }
      presentEvent(event);
    }
    uncertain.clear();
  };

  const drainIfClosed = (): void => {
    if (!deferring) return;
    if ([...uncertain.values()].some((identity) => !identity.closed)) return;
    deferring = false;
    renderBatch();
  };

  return {
    bufferInitial(notification) {
      batch.push(notification);
    },
    flushInitial() {
      const deltaEvents = new Map<
        string,
        Extract<DomainEvent, { type: "text.delta" }>
      >();
      const snapshotKeys = new Set<string>();
      for (const notification of batch) {
        if (notification.method !== "event") continue;
        const event = notification.params;
        if (event.type === "text.delta") {
          deltaEvents.set(messageIdentity(event), event);
        } else if (event.type === "message") {
          snapshotKeys.add(messageIdentity(event));
        }
      }
      for (const [key, event] of deltaEvents) {
        if (!snapshotKeys.has(key)) {
          uncertain.set(key, { turnPrefix: turnPrefix(event), closed: false });
        }
      }
      if (uncertain.size === 0) {
        renderBatch();
        return;
      }
      deferring = true;
      for (const notification of batch) closeUncertainties(notification);
      drainIfClosed();
    },
    present(notification) {
      if (deferring) {
        batch.push(notification);
        closeUncertainties(notification);
        drainIfClosed();
        return;
      }
      if (notification.method === "event") presentEvent(notification.params);
      else
        printNotification(notification.method, notification.params, "pretty");
    },
    isDeferring() {
      return deferring;
    },
    clear() {
      batch.length = 0;
      messages.clear();
      uncertain.clear();
      deferring = false;
    },
  };
}
