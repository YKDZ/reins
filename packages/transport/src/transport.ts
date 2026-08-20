export type TransportErrorCode =
  | "invalid_frame"
  | "transport_closed"
  | "address_in_use";

export type TransportError = Error & { code: TransportErrorCode };

export function createTransportError(
  code: TransportErrorCode,
  message: string,
): TransportError {
  const error = new Error(message) as TransportError;
  error.code = code;
  return error;
}

export function isTransportError(value: unknown): value is TransportError {
  return (
    value instanceof Error &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

export type TransportEvent<TMessage = unknown> =
  | { kind: "message"; message: TMessage }
  | { kind: "error"; error: TransportError }
  | { kind: "closed" };

// 传输接缝：协议层只依赖 send / onEvent / close，不感知具体传输。
export interface TransportConnection<TMessage = unknown> {
  send(message: TMessage): void;
  onEvent(listener: (event: TransportEvent<TMessage>) => void): () => void;
  close(): void;
}

export interface TransportServer<TMessage = unknown> {
  listen(): Promise<void>;
  close(): Promise<void>;
  onConnection(
    listener: (connection: TransportConnection<TMessage>) => void,
  ): () => void;
}
