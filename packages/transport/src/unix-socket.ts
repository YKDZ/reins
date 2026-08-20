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

function wrapSocket<TMessage>(socket: Socket): TransportConnection<TMessage> {
  const listeners = new Set<(event: TransportEvent<TMessage>) => void>();
  let closed = false;
  const decoder = createNdjsonDecoder({
    onMessage(message) {
      emit({ kind: "message", message: message as TMessage });
    },
    onError(error) {
      emit({ kind: "error", error });
    },
  });

  function emit(event: TransportEvent<TMessage>): void {
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  }

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    decoder.push(chunk);
  });
  socket.on("end", () => {
    decoder.end();
  });
  socket.on("close", () => {
    decoder.end();
    if (closed) return;
    closed = true;
    emit({ kind: "closed" });
  });
  socket.on("error", (error) => {
    if (isTransportError(error)) {
      emit({ kind: "error", error });
    } else {
      emit({
        kind: "error",
        error: createTransportError(
          "transport_closed",
          `socket error: ${String(error)}`,
        ),
      });
    }
  });

  return {
    send(message) {
      if (closed || socket.destroyed) {
        throw createTransportError("transport_closed", "connection closed");
      }
      socket.write(encodeNdjson(message), (error) => {
        if (error !== null) {
          emit({
            kind: "error",
            error: createTransportError(
              "transport_closed",
              `write failed: ${String(error)}`,
            ),
          });
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
        const connection = wrapSocket<TMessage>(socket);
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
              createTransportError(
                "address_in_use",
                `socket address already in use: ${options.path}`,
              ),
            );
          } else {
            reject(error);
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
    const connection = wrapSocket<TMessage>(socket);
    socket.once("error", (error) => {
      reject(error);
    });
    socket.once("connect", () => {
      resolve(connection);
    });
  });
}
