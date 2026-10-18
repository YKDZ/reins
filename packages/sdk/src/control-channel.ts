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
  let terminationFailed = false;
  let terminationObserved = false;
  let deferredFailure: TransportError | undefined;
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

  function failAfterDrain(error: TransportError): void {
    if (closed || failureEmitted || deferredFailure !== undefined) return;
    deferredFailure = error;
    void requestChannelClose().catch(() => {
      if (!terminationObserved) emitFailure(error);
    });
  }

  function finish(): void {
    if (closed) return;
    decoder.end();
    if (terminationFailed && deferredFailure === undefined)
      deferredFailure = ioFailure("connection");
    if (deferredFailure !== undefined) emitFailure(deferredFailure);
    closed = true;
    emit({ kind: "closed" });
    void requestChannelClose().catch(() => {
      if (!terminationObserved) emitFailure(ioFailure("connection"));
    });
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
          failAfterDrain(ioFailure("read"));
          break;
        }
        decoder.push(bytes);
      }
      finish();
    } catch {
      failAfterDrain(ioFailure("read"));
      finish();
    }
  }

  function requestChannelClose(): Promise<void> {
    closing = true;
    closePromise ??= Promise.resolve().then(() => channel.close());
    return closePromise;
  }

  function closeAndWait(): Promise<void> {
    return requestChannelClose().then(() => writeQueue);
  }

  void consume();
  void channel.terminated.then(
    (termination) => {
      terminationObserved = true;
      terminationFailed =
        termination.exitCode !== 0 || termination.signal !== null;
      void requestChannelClose().catch(() => {
        if (!terminationObserved) emitFailure(ioFailure("connection"));
      });
    },
    () => {
      terminationObserved = true;
      terminationFailed = true;
      void requestChannelClose().catch(() => {
        if (!terminationObserved) emitFailure(ioFailure("connection"));
      });
    },
  );

  return {
    connection: {
      send(message) {
        if (closed || closing || writeFailed) throw disconnectedFailure();
        const bytes = encoder.encode(encodeNdjson(message));
        writeQueue = writeQueue.then(async () => {
          if (closed || closing || writeFailed) return;
          try {
            await channel.write(bytes);
          } catch {
            writeFailed = true;
            failAfterDrain(ioFailure("write"));
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
