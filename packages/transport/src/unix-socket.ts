import { unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";

import { createNdjsonDecoder, encodeNdjson } from "./ndjson.ts";
import {
  createTransportError,
  isTransportError,
  type TransportConnection,
  type TransportEvent,
  type TransportServer,
} from "./transport.ts";

/** @internal 仅供 Unix Adapter 及其真实 socket contract test 使用。 */
export function wrapUnixSocket<TMessage>(
  socket: Socket,
): TransportConnection<TMessage> {
  const listeners = new Set<(event: TransportEvent<TMessage>) => void>();
  let closed = false;
  let failureEmitted = false;
  const decoder = createNdjsonDecoder({
    onMessage(message) {
      emit({ kind: "message", message: message as TMessage });
    },
    onError(error) {
      emitFailure(error);
    },
  });

  function emit(event: TransportEvent<TMessage>): void {
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  }

  function emitFailure(
    error: Extract<TransportEvent<TMessage>, { kind: "error" }>["error"],
  ): void {
    if (closed || failureEmitted) return;
    failureEmitted = true;
    emit({ kind: "error", error });
  }

  function emitIoFailure(operation: "connection" | "write"): void {
    emitFailure(
      createTransportError({
        code: "io_error",
        fact: {
          kind: "transport_failure",
          operation,
          reason: "io_error",
        },
      }),
    );
  }

  socket.on("data", (chunk: Buffer) => {
    decoder.push(chunk);
  });
  socket.on("end", () => {
    decoder.end();
  });
  socket.on("close", (hadError) => {
    decoder.end();
    if (closed) return;
    if (hadError) emitIoFailure("connection");
    closed = true;
    emit({ kind: "closed" });
  });
  socket.on("error", (error) => {
    if (isTransportError(error)) {
      emitFailure(error);
    } else {
      emitIoFailure("connection");
    }
  });

  return {
    send(message) {
      if (closed || socket.destroyed) {
        throw createTransportError({
          code: "transport_closed",
          fact: {
            kind: "transport_failure",
            operation: "write",
            reason: "disconnected",
          },
        });
      }
      socket.write(encodeNdjson(message), (error) => {
        if (error !== null) {
          emitIoFailure("write");
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      socket.end();
    },
  };
}

export function createUnixSocketServer<TMessage = unknown>(options: {
  path: string;
}): TransportServer<TMessage> {
  let server: Server | null = null;
  const connections = new Set<TransportConnection<TMessage>>();
  const connectionListeners = new Set<
    (connection: TransportConnection<TMessage>) => void
  >();

  return {
    async listen() {
      if (server !== null) return;
      server = createServer((socket) => {
        const connection = wrapUnixSocket<TMessage>(socket);
        connections.add(connection);
        connection.onEvent((event) => {
          if (event.kind === "closed") connections.delete(connection);
        });
        for (const listener of Array.from(connectionListeners)) {
          listener(connection);
        }
      });
      const srv = server;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error & { code?: string }): void => {
          srv.removeListener("listening", onListening);
          server = null;
          if (error.code === "EADDRINUSE") {
            reject(
              createTransportError({
                code: "address_in_use",
                fact: {
                  kind: "transport_failure",
                  operation: "listen",
                  reason: "io_error",
                },
              }),
            );
          } else {
            reject(
              createTransportError({
                code: "io_error",
                fact: {
                  kind: "transport_failure",
                  operation: "listen",
                  reason: "io_error",
                },
              }),
            );
          }
        };
        const onListening = (): void => {
          srv.removeListener("error", onError);
          resolve();
        };
        srv.once("error", onError);
        srv.once("listening", onListening);
        srv.listen(options.path);
      });
    },
    async close() {
      if (server === null) return;
      for (const connection of Array.from(connections)) {
        connection.close();
      }
      connections.clear();
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
      server = null;
      await unlink(options.path).catch(() => {});
    },
    onConnection(listener) {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },
  };
}

export function createUnixSocketClient<TMessage = unknown>(
  path: string,
): Promise<TransportConnection<TMessage>> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const onConnectError = (): void => {
      reject(
        createTransportError({
          code: "io_error",
          fact: {
            kind: "transport_failure",
            operation: "connect",
            reason: "io_error",
          },
        }),
      );
    };
    socket.once("error", onConnectError);
    socket.once("connect", () => {
      const connection = wrapUnixSocket<TMessage>(socket);
      socket.removeListener("error", onConnectError);
      resolve(connection);
    });
  });
}
