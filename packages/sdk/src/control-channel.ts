import type { ProtocolMessage } from "@reins/protocol";
import {
  createNdjsonDecoder,
  createTransportError,
  encodeNdjson,
  type TransportConnection,
  type TransportEvent,
  type TransportError,
} from "@reins/transport";

import type { ControlByteChannel } from "./contracts.ts";

type ControlByteTransport = {
  readonly connection: TransportConnection<ProtocolMessage>;
  closeAndWait(): Promise<void>;
};

function ioFailure(
  operation: "connection" | "read" | "write",
): ReturnType<typeof createTransportError> {
  return createTransportError({
    code: "io_error",
    fact: {
      kind: "transport_failure",
      operation,
      reason: "io_error",
    },
  });
}

function disconnectedFailure(): ReturnType<typeof createTransportError> {
  return createTransportError({
    code: "transport_closed",
    fact: {
      kind: "transport_failure",
      operation: "write",
      reason: "disconnected",
    },
  });
}

export function createControlByteTransport(
  channel: ControlByteChannel,
): ControlByteTransport {
  const listeners = new Set<(event: TransportEvent<ProtocolMessage>) => void>();
  const encoder = new TextEncoder();
  let closed = false;
  let closing = false;
  let failureEmitted = false;
  let writeFailed = false;
  let writeQueue = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  function emit(event: TransportEvent<ProtocolMessage>): void {
    for (const listener of Array.from(listeners)) listener(event);
  }

  function emitFailure(error: TransportError): void {
    if (closed || failureEmitted) return;
    failureEmitted = true;
    emit({ kind: "error", error });
  }

  function finish(): void {
    if (closed) return;
    decoder.end();
    closed = true;
    emit({ kind: "closed" });
  }

  const decoder = createNdjsonDecoder({
    onMessage(message) {
      emit({ kind: "message", message: message as ProtocolMessage });
    },
    onError(error) {
      emitFailure(error);
    },
  });

  async function consume(): Promise<void> {
    try {
      for await (const bytes of channel.readable) {
        if (closed) break;
        if (!(bytes instanceof Uint8Array)) {
          emitFailure(ioFailure("read"));
          break;
        }
        decoder.push(bytes);
      }
      finish();
    } catch {
      emitFailure(ioFailure("read"));
      finish();
    }
  }

  function closeAndWait(): Promise<void> {
    closing = true;
    closePromise ??= writeQueue.then(() => channel.close());
    return closePromise;
  }

  void consume();
  void channel.terminated.then(
    () => undefined,
    () => {
      emitFailure(ioFailure("connection"));
    },
  );

  return {
    connection: {
      send(message) {
        if (closed || closing || writeFailed) throw disconnectedFailure();
        const bytes = encoder.encode(encodeNdjson(message));
        writeQueue = writeQueue.then(async () => {
          if (closed || writeFailed) return;
          try {
            await channel.write(bytes);
          } catch {
            writeFailed = true;
            emitFailure(ioFailure("write"));
            void closeAndWait().catch(() => {
              emitFailure(ioFailure("connection"));
            });
          }
        });
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        void closeAndWait().catch(() => {
          emitFailure(ioFailure("connection"));
        });
      },
    },
    closeAndWait,
  };
}
