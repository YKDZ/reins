import { createTransportError, type TransportError } from "./transport.ts";

export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

// NDJSON 解码器：按行缓冲、解析并分发；非法 JSON 帧以 invalid_frame 错误暴露。
export function createNdjsonDecoder(handlers: {
  onMessage(message: unknown): void;
  onError(error: TransportError): void;
}): {
  push(chunk: string): void;
  end(): void;
} {
  let buffer = "";

  function parseLine(line: string): void {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      handlers.onError(
        createTransportError("invalid_frame", `invalid NDJSON frame: ${line}`),
      );
      return;
    }
    handlers.onMessage(parsed);
  }

  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        parseLine(line);
      }
    },
    end() {
      if (buffer.length > 0) {
        const line = buffer;
        buffer = "";
        parseLine(line);
      }
    },
  };
}
