import { AsyncLocalStorage } from "node:async_hooks";

import type { ConsumerContext, SessionId } from "@reins/protocol";

/**
 * daemon 内部的消费者归属。请求因果用 AsyncLocalStorage 传递，会话归属用
 * 表记录；两者只服务 daemon 内部路由与诊断范围，不进入协议参数或结果。
 */
export type ConsumerScope = {
  within<T>(consumer: ConsumerContext, run: () => T): T;
  current(): ConsumerContext | undefined;
  ownerOf(sessionId: SessionId): ConsumerContext | undefined;
  inScope(consumer: ConsumerContext, sessionId: SessionId): boolean;
  ownerForFact(fact: unknown): ConsumerContext | undefined;
};

export function createConsumerScope(
  ownerOf: (sessionId: SessionId) => ConsumerContext | undefined = () =>
    undefined,
): ConsumerScope {
  const storage = new AsyncLocalStorage<ConsumerContext>();

  return {
    within: (consumer, run) => storage.run(consumer, run),
    current: () => storage.getStore(),
    ownerOf,
    inScope(consumer, sessionId) {
      return ownerOf(sessionId) === consumer;
    },
    ownerForFact(fact: unknown) {
      if (typeof fact !== "object" || fact === null) return undefined;
      const sessionId = (fact as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string") {
        const owner = ownerOf(sessionId as SessionId);
        if (owner !== undefined) return owner;
      }
      return storage.getStore();
    },
  };
}
