import { REINS_PROTOCOL_MAJOR_VERSION } from "@reins/protocol";
import { createInMemoryTransportPair } from "@reins/transport";
import { expect, test, vi } from "vitest";

import { createReinsClient } from "../../src/index.ts";

const binding = { consumerContext: "alpha" as const };

test("initialize 以必填消费者上下文与协议主版本握手并交出 daemon 世代", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const handshake = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd" as never,
    },
  });

  await expect(handshake).resolves.toEqual({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd",
    },
  });
  client.close();
});

test("握手请求携带消费者绑定而非领域参数", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const sent: unknown[] = [];
  pair.server.onEvent((event) => {
    if (event.kind === "message") sent.push(event.message);
  });
  const handshake = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd" as never,
    },
  });
  await handshake;

  expect(sent).toEqual([
    {
      kind: "request",
      requestId: "cli1",
      method: "initialize",
      params: {
        protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
        consumerContext: "alpha",
      },
    },
  ]);
  client.close();
});

test("静默 daemon 下握手按调用方时限结束而不拖满请求默认时限", async () => {
  vi.useFakeTimers();
  try {
    const pair = createInMemoryTransportPair();
    const client = createReinsClient(pair.client as never, binding);
    const handshake = client.initialize(1_000);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    await expect(handshake).rejects.toThrow("daemon_timeout");
    client.close();
  } finally {
    vi.useRealTimers();
  }
});

test("版本不匹配的握手响应原样交出且不再发出领域请求", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const sent: unknown[] = [];
  pair.server.onEvent((event) => {
    if (event.kind === "message") sent.push(event.message);
  });
  const handshake = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    error: {
      code: "protocol_version_mismatch" as never,
      requestedProtocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION + 1,
      supportedProtocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    },
  });

  await expect(handshake).resolves.toMatchObject({
    error: { code: "protocol_version_mismatch" },
  });
  expect(sent).toHaveLength(1);
  client.close();
});

test("malformed inbound envelope rejects an outstanding request as invalid daemon response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const pending = client.request("capabilities", {});
  pair.server.send({ kind: "notification", method: "event", params: {} });
  await expect(pending).rejects.toThrow("invalid_daemon_response");
  client.close();
});

test("a schema-invalid response result rejects as invalid daemon response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const pending = client.request("capabilities", {});
  pair.server.send({ kind: "response", requestId: "cli1", result: {} });
  await expect(pending).rejects.toThrow("invalid_daemon_response");
  client.close();
});

test("invalid input terminates every lifecycle listener with the concrete reason", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const reason = new Promise((resolve) => client.onClosed(resolve));
  pair.server.send({ kind: "notification", method: "event", params: {} });
  await expect(reason).resolves.toEqual({ code: "invalid_daemon_response" });
  client.close();
});

test("an invalid result terminates the client with invalid_daemon_response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const reason = new Promise((resolve) => client.onClosed(resolve));
  const pending = client.request("capabilities", {});
  pair.server.send({ kind: "response", requestId: "cli1", result: {} });
  await expect(pending).rejects.toThrow("invalid_daemon_response");
  await expect(reason).resolves.toEqual({ code: "invalid_daemon_response" });
  client.close();
});

test("a malformed notification after a valid response preserves invalid_daemon_response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const pending = client.request("attach", { sessionId: "prompt@g1" as never });
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: { sessionId: "prompt@g1", replayed: 0 },
  });
  await expect(pending).resolves.toMatchObject({ kind: "response" });
  const reason = new Promise((resolve) => client.onClosed(resolve));
  pair.server.send({ kind: "notification", method: "event", params: {} });
  await expect(reason).resolves.toEqual({ code: "invalid_daemon_response" });
  client.close();
});

test("client close rejects a pending request without waiting for its timeout", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const pending = client.request("capabilities", {}, 30_000);
  client.close();
  await expect(pending).rejects.toThrow("daemon_disconnected");
});

test("request timeout rejects with the distinct daemon_timeout machine error", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  await expect(client.request("capabilities", {}, 1)).rejects.toThrow(
    "daemon_timeout",
  );
  client.close();
});

test("a settled response removes its request timer", async () => {
  vi.useFakeTimers();
  try {
    const pair = createInMemoryTransportPair();
    const client = createReinsClient(pair.client as never, binding);
    const pending = client.request("capabilities", {}, 30_000);
    expect(vi.getTimerCount()).toBe(1);
    pair.server.send({
      kind: "response",
      requestId: "cli1",
      result: { capabilities: [], failures: [] },
    });
    await expect(pending).resolves.toMatchObject({ kind: "response" });
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  } finally {
    vi.useRealTimers();
  }
});

test("a request made after close rejects without installing a timer", async () => {
  vi.useFakeTimers();
  try {
    const pair = createInMemoryTransportPair();
    const client = createReinsClient(pair.client as never, binding);
    client.close();
    await expect(client.request("capabilities", {})).rejects.toThrow(
      "daemon_disconnected",
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("副作用超时保留命令身份、不泄露原参，也不自动重发", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const sent: unknown[] = [];
  pair.server.onEvent((event) => {
    if (event.kind === "message") sent.push(event.message);
  });
  const handshake = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd",
    },
  });
  await handshake;
  let error: unknown;
  try {
    await client.request(
      "spawn",
      {
        harness: "fake",
        cwd: "/tmp",
        sessionName: "worker" as never,
        message: "sensitive original",
      },
      5,
    );
  } catch (caught) {
    error = JSON.parse((caught as Error).message);
  }
  expect(error).toMatchObject({
    code: "command_outcome_unknown",
    cause: "timeout",
    method: "spawn",
    daemonGeneration: "ab12cd",
    commandId: expect.stringMatching(/^ab12cd:/),
    retryToken: expect.any(String),
  });
  expect(JSON.stringify(error)).not.toContain("sensitive original");
  expect(sent).toHaveLength(2);
  client.close();
});

test.each([
  ["send", { sessionId: "worker@gab12cd", message: "private-message" }],
  ["interrupt", { ids: ["worker@gab12cd"] }],
  ["kill", { sessionId: "worker@gab12cd" }],
  [
    "resolvePermission",
    {
      sessionId: "worker@gab12cd",
      permissionId: "p1",
      resolution: { outcome: "deny", feedback: "private-feedback" },
    },
  ],
] as const)(
  "%s 自动取得命令身份，断连为未知且不复制原参数",
  async (method, params) => {
    const pair = createInMemoryTransportPair();
    const client = createReinsClient(pair.client as never, binding);
    const sent: Array<Record<string, unknown>> = [];
    pair.server.onEvent((event) => {
      if (event.kind === "message")
        sent.push(event.message as Record<string, unknown>);
    });
    const initialized = client.initialize();
    pair.server.send({
      kind: "response",
      requestId: "cli1",
      result: {
        protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
        daemonGeneration: "ab12cd",
      },
    });
    await initialized;
    const pending = client.request(method, params as never);
    await Promise.resolve();
    pair.server.close();
    let error: unknown;
    try {
      await pending;
    } catch (caught) {
      error = JSON.parse((caught as Error).message);
    }
    expect(error).toMatchObject({
      code: "command_outcome_unknown",
      cause: "disconnected",
      method,
      targets: ["worker@gab12cd"],
    });
    expect(JSON.stringify(error)).not.toContain("private-message");
    expect(JSON.stringify(error)).not.toContain("private-feedback");
    expect(sent[1]).toMatchObject({
      method,
      params,
      commandId: expect.stringMatching(/^ab12cd:/),
    });
    expect(sent).toHaveLength(2);
    client.close();
  },
);

test("已关闭客户端确定未发送；安全查询断连保持普通错误", async () => {
  const pair = createInMemoryTransportPair();
  const send = vi.spyOn(pair.client, "send");
  const client = createReinsClient(pair.client as never, binding);
  const pending = client.request("list", {});
  pair.server.close();
  await expect(pending).rejects.toThrow('"code":"daemon_disconnected"');

  await expect(
    client.request("spawn", {
      harness: "fake",
      cwd: "/tmp",
      sessionName: "unused" as never,
      message: "never-sent",
    }),
  ).rejects.toThrow('"code":"daemon_disconnected"');
  expect(send).toHaveBeenCalledTimes(1);
  client.close();
});

test("显式恢复保留原目录事实，不要求调用方重填 CLI 自动投影的目录身份", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const sent: Array<Record<string, unknown>> = [];
  pair.server.onEvent((event) => {
    if (event.kind === "message")
      sent.push(event.message as Record<string, unknown>);
  });
  const initialized = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd",
    },
  });
  await initialized;
  const caller = {
    harness: "fake",
    sessionName: "original-dir",
    message: "private initial task",
  };
  const original = {
    ...caller,
    cwd: "/original/absolute/path",
    cwdIdentity: { device: "43", inode: "9876" },
  };
  let token: string | undefined;
  try {
    await client.request("spawn", original as never, 5);
  } catch (error) {
    token = (JSON.parse((error as Error).message) as { retryToken: string })
      .retryToken;
  }
  expect(token).toEqual(expect.any(String));
  expect(
    Buffer.from(token!.slice(7), "base64url").toString("utf8"),
  ).not.toContain("private initial task");
  const recovered = client.retry(token!, caller);
  await Promise.resolve();
  expect(sent[2]).toMatchObject({
    method: "spawn",
    params: original,
    commandId: sent[1]?.commandId,
  });
  pair.server.send({
    kind: "response",
    requestId: "cli3",
    result: {
      sessionId: "original-dir@gab12cd",
      turnId: "t1",
      cwd: original.cwd,
    },
  });
  await recovered;
  client.close();
});

test("损坏 ACK 终止连接时，已发送副作用保留恢复身份，只读请求保留无效响应语义", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const initialized = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd",
    },
  });
  await initialized;
  const pending = Promise.allSettled([
    client.request("spawn", {
      harness: "fake",
      cwd: "/tmp",
      sessionName: "invalid" as never,
      message: "private task",
    }),
    client.request("kill", { sessionId: "worker@gab12cd" as never }),
    client.request("capabilities", {}),
  ]);
  pair.server.send({ kind: "response", requestId: "cli2", result: {} });
  const failures = (await pending).map((result) => {
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("Expected rejection");
    return JSON.parse((result.reason as Error).message) as unknown;
  });
  expect(failures).toMatchObject([
    {
      code: "command_outcome_unknown",
      cause: "invalid_daemon_response",
      method: "spawn",
      commandId: expect.stringMatching(/^ab12cd:/),
      retryToken: expect.any(String),
    },
    {
      code: "command_outcome_unknown",
      cause: "invalid_daemon_response",
      method: "kill",
      commandId: expect.stringMatching(/^ab12cd:/),
      retryToken: expect.any(String),
    },
    { code: "invalid_daemon_response" },
  ]);
  expect(JSON.stringify(failures)).not.toContain("private task");
  client.close();
});

test("副作用已知机器错误仍原样返回且连接继续接收已知成功", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const initialized = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd",
    },
  });
  await initialized;
  const failed = client.request("send", {
    sessionId: "missing@gab12cd" as never,
    message: "caller task",
  });
  const error = {
    code: "session_not_found",
    sessionId: "missing@gab12cd",
  };
  pair.server.send({ kind: "response", requestId: "cli2", error });
  await expect(failed).resolves.toEqual({
    kind: "response",
    requestId: "cli2",
    error,
  });
  const succeeded = client.request("kill", {
    sessionId: "worker@gab12cd" as never,
  });
  pair.server.send({
    kind: "response",
    requestId: "cli3",
    result: { sessionId: "worker@gab12cd", status: "killed" },
  });
  await expect(succeeded).resolves.toEqual({
    kind: "response",
    requestId: "cli3",
    result: { sessionId: "worker@gab12cd", status: "killed" },
  });
  client.close();
});

test.each([undefined,60_000])("wait keeps its domain budget beyond the ordinary 30s request timer (%s)", async timeoutMs => {
  vi.useFakeTimers();
  const pair=createInMemoryTransportPair();
  const client=createReinsClient(pair.client as never,binding);
  try {
    let settled=false;
    const waiting=client.request("wait",{targets:[{sessionId:"worker@g1" as never,turnId:"t1" as never}],completion:"all",...(timeoutMs===undefined ? {} : {timeoutMs})}).finally(() => {settled=true;});
    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBe(false);
    pair.server.send({kind:"response",requestId:"cli1",result:{status:"satisfied",completed:[{sessionId:"worker@g1",turnId:"t1",stopReason:"end_turn",finalReply:"caller result"}],pending:[]}});
    await expect(waiting).resolves.toMatchObject({result:{status:"satisfied"}});
  } finally {client.close();vi.useRealTimers();}
});

test.each(["disconnect","malformed"])("wait preserves the real transport error on %s",async failure => {
  const pair=createInMemoryTransportPair();
  const client=createReinsClient(pair.client as never,binding);
  const waiting=client.request("wait",{targets:[{sessionId:"worker@g1" as never,turnId:"t1" as never}],completion:"all",timeoutMs:0});
  if(failure==="disconnect") pair.server.close();
  else pair.server.send({kind:"response",requestId:"cli1",result:{status:"timeout",completed:"not an array",pending:[]}});
  await expect(waiting).rejects.toThrow(failure==="disconnect" ? "daemon_disconnected" : "invalid_daemon_response");
  client.close();
});
