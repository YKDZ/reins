import { describe, expect, test } from "vitest";

import {
  createNdjsonDecoder,
  encodeNdjson,
  isTransportError,
} from "../../src/index.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function collect(): {
  decoder: ReturnType<typeof createNdjsonDecoder>;
  messages: unknown[];
  errors: unknown[];
} {
  const messages: unknown[] = [];
  const errors: unknown[] = [];
  const decoder = createNdjsonDecoder({
    onMessage(message) {
      messages.push(message);
    },
    onError(error) {
      errors.push(error);
    },
  });
  return { decoder, messages, errors };
}

describe("NDJSON 编解码", () => {
  test("encode 输出单行 JSON 并以换行结尾", () => {
    expect(encodeNdjson({ kind: "request", id: 1 })).toBe(
      '{"kind":"request","id":1}\n',
    );
  });

  test("一个 chunk 内的完整行被解析为消息", () => {
    const { decoder, messages, errors } = collect();
    decoder.push(bytes('{"a":1}\n'));
    expect(messages).toEqual([{ a: 1 }]);
    expect(errors).toEqual([]);
  });

  test("一个 chunk 内的多行被逐条解析", () => {
    const { decoder, messages } = collect();
    decoder.push(bytes('{"a":1}\n{"b":2}\n'));
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("跨 chunk 拆分的行被缓冲到完整后再解析", () => {
    const { decoder, messages } = collect();
    decoder.push(bytes('{"a":'));
    expect(messages).toEqual([]);
    decoder.push(bytes("1}\n"));
    expect(messages).toEqual([{ a: 1 }]);
  });

  test("多字节 UTF-8 字符在字节中间跨 chunk 仍精确解码", () => {
    const { decoder, messages, errors } = collect();
    const frame = bytes('{"text":"中"}\n');
    const characterStart = frame.indexOf(bytes("中")[0] as number);
    decoder.push(frame.slice(0, characterStart + 1));
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
    decoder.push(frame.slice(characterStart + 1));
    expect(messages).toEqual([{ text: "中" }]);
    expect(errors).toEqual([]);
  });

  test("空行被忽略", () => {
    const { decoder, messages, errors } = collect();
    decoder.push(bytes("\n\n"));
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("非法 JSON 行触发带 invalid_frame 码的传输错误", () => {
    const { decoder, messages, errors } = collect();
    const secretSentinel = ["transport", "secret", "sentinel"].join("-");
    const line = `{"tool_result":"${secretSentinel}"`;
    decoder.push(bytes(`${line}\n`));
    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
    const error = errors[0];
    if (!isTransportError(error)) throw new Error("Expected transport error");
    expect(error.code).toBe("invalid_frame");
    expect(error.fact).toEqual({
      kind: "transport_failure",
      operation: "read",
      reason: "invalid_frame",
      inputBytes: new TextEncoder().encode(line).length,
    });
    expect(error.message.includes(secretSentinel)).toBe(false);
    expect(JSON.stringify(error.fact).includes(secretSentinel)).toBe(false);
  });

  test("非法 UTF-8 不经 replacement character 改写字节数", () => {
    const { decoder, messages, errors } = collect();
    decoder.push(Uint8Array.from([0x80, 0x0a]));
    expect(messages).toEqual([]);
    const error = errors[0];
    if (!isTransportError(error)) throw new Error("Expected transport error");
    expect(error.fact).toEqual({
      kind: "transport_failure",
      operation: "read",
      reason: "invalid_frame",
      inputBytes: 1,
    });
  });

  test("end 时冲刷未换行结尾的剩余缓冲", () => {
    const { decoder, messages, errors } = collect();
    decoder.push(bytes('{"a":1}'));
    decoder.end();
    expect(messages).toEqual([{ a: 1 }]);
    expect(errors).toEqual([]);
  });

  test("end 时残留的非法缓冲触发错误", () => {
    const { decoder, messages, errors } = collect();
    decoder.push(bytes("broken"));
    decoder.end();
    expect(messages).toEqual([]);
    const error = errors[0];
    if (!isTransportError(error)) throw new Error("Expected transport error");
    expect(error.code).toBe("invalid_frame");
    expect(error.fact).toMatchObject({ inputBytes: bytes("broken").length });
  });
});
