// Unix 响应代理只丢弃 daemon 已真实发送的目标成功 ACK，不代替业务模块。
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

export type AcknowledgementDrop = {
  readonly method: "spawn" | "send" | "interrupt" | "kill";
  readonly requestId: string;
  readonly commandId: string;
  readonly result: unknown;
};

type TargetRequest = Pick<
  AcknowledgementDrop,
  "method" | "requestId" | "commandId"
>;

export type UnixAcknowledgementProxy = {
  readonly socketPath: string;
  readonly waitForDroppedAcknowledgement: () => Promise<AcknowledgementDrop>;
  readonly close: () => Promise<void>;
};

export type UnixConnectionProxy = {
  readonly socketPath: string;
  close(): Promise<void>;
};

export type UnixAcknowledgementProxyOptions = {
  readonly socketPath: string;
  readonly targetPath: string;
  readonly method: AcknowledgementDrop["method"];
  readonly commandId?: string;
};

export async function startUnixAcknowledgementProxy(
  options: UnixAcknowledgementProxyOptions,
): Promise<UnixAcknowledgementProxy> {
  const sockets = new Set<Socket>();
  let dropped = false;
  let resolveDropped!: (drop: AcknowledgementDrop) => void;
  let rejectDropped!: (error: Error) => void;
  const droppedAcknowledgement = new Promise<AcknowledgementDrop>(
    (resolve, reject) => {
      resolveDropped = resolve;
      rejectDropped = reject;
    },
  );
  void droppedAcknowledgement.catch(() => undefined);

  const server: Server = createServer((downstream) => {
    const upstream = createConnection(options.targetPath);
    sockets.add(downstream);
    sockets.add(upstream);
    const targetRequests = new Map<string, TargetRequest>();
    let requestBuffer = "";
    let responseBuffer = "";

    const stopPair = (error?: Error): void => {
      if (error !== undefined && !dropped) rejectDropped(error);
      downstream.destroy();
      upstream.destroy();
    };

    downstream.on("data", (chunk) => {
      requestBuffer += chunk.toString("utf8");
      for (;;) {
        const lineEnd = requestBuffer.indexOf("\n");
        if (lineEnd === -1) break;
        const line = requestBuffer.slice(0, lineEnd);
        requestBuffer = requestBuffer.slice(lineEnd + 1);
        if (line === "") continue;
        try {
          const request: unknown = JSON.parse(line);
          if (
            typeof request === "object" &&
            request !== null &&
            "method" in request &&
            request.method === options.method &&
            "requestId" in request &&
            typeof request.requestId === "string" &&
            "commandId" in request &&
            typeof request.commandId === "string" &&
            (options.commandId === undefined ||
              request.commandId === options.commandId)
          ) {
            targetRequests.set(request.requestId, {
              method: options.method,
              requestId: request.requestId,
              commandId: request.commandId,
            });
          }
          upstream.write(`${line}\n`);
        } catch (error) {
          stopPair(
            error instanceof Error
              ? error
              : new Error("Unable to parse proxied request"),
          );
          return;
        }
      }
    });

    upstream.on("data", (chunk) => {
      responseBuffer += chunk.toString("utf8");
      for (;;) {
        const lineEnd = responseBuffer.indexOf("\n");
        if (lineEnd === -1) break;
        const line = responseBuffer.slice(0, lineEnd);
        responseBuffer = responseBuffer.slice(lineEnd + 1);
        if (line === "") continue;
        try {
          const response: unknown = JSON.parse(line);
          if (
            !dropped &&
            typeof response === "object" &&
            response !== null &&
            "kind" in response &&
            response.kind === "response" &&
            "requestId" in response &&
            typeof response.requestId === "string"
          ) {
            const target = targetRequests.get(response.requestId);
            if (target !== undefined) {
              targetRequests.delete(response.requestId);
              if ("result" in response && response.result !== undefined) {
                dropped = true;
                resolveDropped({ ...target, result: response.result });
                stopPair();
                return;
              }
            }
          }
          downstream.write(`${line}\n`);
        } catch (error) {
          stopPair(
            error instanceof Error
              ? error
              : new Error("Unable to parse proxied response"),
          );
          return;
        }
      }
    });

    upstream.on("error", (error) => stopPair(error));
    downstream.on("error", (error) => stopPair(error));
    downstream.on("close", () => {
      if (!dropped)
        rejectDropped(new Error("Proxy downstream closed before target ACK"));
      upstream.destroy();
    });
    upstream.on("close", () => {
      if (!dropped) rejectDropped(new Error("Daemon closed before target ACK"));
      downstream.destroy();
    });
    downstream.on("close", () => sockets.delete(downstream));
    upstream.on("close", () => sockets.delete(upstream));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolve);
  });

  return {
    socketPath: options.socketPath,
    waitForDroppedAcknowledgement: () => droppedAcknowledgement,
    close: async () => {
      if (!dropped) rejectDropped(new Error("Proxy closed before target ACK"));
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}

// 只转发真实 Unix socket 字节流；close 用于让一个正式消费者观察到传输断开。
export async function startUnixConnectionProxy(options: {
  readonly socketPath: string;
  readonly targetPath: string;
}): Promise<UnixConnectionProxy> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((downstream) => {
    const upstream = createConnection(options.targetPath);
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("close", () => sockets.delete(downstream));
    upstream.on("close", () => sockets.delete(upstream));
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolve);
  });

  let closed = false;
  return {
    socketPath: options.socketPath,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}
