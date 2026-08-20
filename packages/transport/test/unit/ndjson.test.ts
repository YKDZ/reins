import { describe, expect, test } from "vitest";

import {
  createNdjsonDecoder,
  encodeNdjson,
  isTransportError,
} from "../../src/index.ts";

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
    decoder.push('{"a":1}\n');
    expect(messages).toEqual([{ a: 1 }]);
    expect(errors).toEqual([]);
  });

  test("一个 chunk 内的多行被逐条解析", () => {
    const { decoder, messages } = collect();
    decoder.push('{"a":1}\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("跨 chunk 拆分的行被缓冲到完整后再解析", () => {
    const { decoder, messages } = collect();
    decoder.push('{"a":');
    expect(messages).toEqual([]);
    decoder.push("1}\n");
    expect(messages).toEqual([{ a: 1 }]);
  });

  test("空行被忽略", () => {
    const { decoder, messages, errors } = collect();
    decoder.push("\n\n");
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("非法 JSON 行触发带 invalid_frame 码的传输错误", () => {
    const { decoder, messages, errors } = collect();
    decoder.push("not json\n");
    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(isTransportError(errors[0])).toBe(true);
    expect((errors[0] as Error & { code?: string }).code).toBe("invalid_frame");
  });

  test("end 时冲刷未换行结尾的剩余缓冲", () => {
    const { decoder, messages, errors } = collect();
    decoder.push('{"a":1}');
    decoder.end();
    expect(messages).toEqual([{ a: 1 }]);
    expect(errors).toEqual([]);
  });

  test("end 时残留的非法缓冲触发错误", () => {
    const { decoder, messages, errors } = collect();
    decoder.push("broken");
    decoder.end();
    expect(messages).toEqual([]);
    expect((errors[0] as Error & { code?: string }).code).toBe("invalid_frame");
  });
});
