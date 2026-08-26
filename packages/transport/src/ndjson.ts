import { createTransportError, type TransportError } from "./transport.ts";

export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

// NDJSON 解码器：按行缓冲、解析并分发；非法 JSON 帧以 invalid_frame 错误暴露。
export function createNdjsonDecoder(handlers: {
  onMessage(message: unknown): void;
  onError(error: TransportError): void;
}): {
  push(chunk: Uint8Array): void;
  end(): void;
} {
  let buffer = new Uint8Array();
  const textDecoder = new TextDecoder("utf-8", { fatal: true });

  function parseLine(line: Uint8Array): void {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(textDecoder.decode(line)) as unknown;
    } catch {
      handlers.onError(
        createTransportError({
          code: "invalid_frame",
          fact: {
            kind: "transport_failure",
            operation: "read",
            reason: "invalid_frame",
            inputBytes: line.length,
          },
        }),
      );
      return;
    }
    handlers.onMessage(parsed);
  }

  return {
    push(chunk) {
      const combined = new Uint8Array(buffer.length + chunk.length);
      combined.set(buffer);
      combined.set(chunk, buffer.length);
      buffer = combined;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf(0x0a)) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        parseLine(line);
      }
    },
    end() {
      if (buffer.length > 0) {
        const line = buffer;
        buffer = new Uint8Array();
        parseLine(line);
      }
    },
  };
}
