import {
  createTransportError,
  type TransportConnection,
  type TransportEvent,
  type TransportServer,
} from "./transport.ts";

type Endpoint<TMessage> = {
  closed: boolean;
  listeners: Set<(event: TransportEvent<TMessage>) => void>;
};

function makeEndpoint<TMessage>(
  self: Endpoint<TMessage>,
  peer: Endpoint<TMessage>,
): TransportConnection<TMessage> {
  return {
    send(message) {
      if (self.closed) {
        throw createTransportError("transport_closed", "connection closed");
      }
      queueMicrotask(() => {
        if (peer.closed) return;
        for (const listener of Array.from(peer.listeners)) {
          listener({ kind: "message", message });
        }
      });
    },
    onEvent(listener) {
      self.listeners.add(listener);
      return () => {
        self.listeners.delete(listener);
      };
    },
    close() {
      if (self.closed) return;
      self.closed = true;
      queueMicrotask(() => {
        for (const listener of Array.from(peer.listeners)) {
          listener({ kind: "closed" });
        }
      });
    },
  };
}

// 进程内双端传输对：daemon 缝 C 的测试替身，消息经微任务投递。
export function createInMemoryTransportPair<TMessage = unknown>(): {
  client: TransportConnection<TMessage>;
  server: TransportConnection<TMessage>;
} {
  const clientEnd: Endpoint<TMessage> = { closed: false, listeners: new Set() };
  const serverEnd: Endpoint<TMessage> = { closed: false, listeners: new Set() };
  return {
    client: makeEndpoint(clientEnd, serverEnd),
    server: makeEndpoint(serverEnd, clientEnd),
  };
}

// 进程内传输服务器：daemon 缝 C 的测试替身，connect() 即新建一个客户端连接。
export function createInMemoryTransportServer<
  TMessage = unknown,
>(): TransportServer<TMessage> & {
  connect(): TransportConnection<TMessage>;
} {
  const listeners = new Set<
    (connection: TransportConnection<TMessage>) => void
  >();
  let listening = false;
  return {
    async listen() {
      listening = true;
    },
    async close() {
      listening = false;
      listeners.clear();
    },
    onConnection(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect() {
      const pair = createInMemoryTransportPair<TMessage>();
      queueMicrotask(() => {
        if (!listening) return;
        for (const listener of Array.from(listeners)) {
          listener(pair.server);
        }
      });
      return pair.client;
    },
  };
}
