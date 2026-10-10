import { AsyncLocalStorage } from "node:async_hooks";

import type { ConsumerContext, SessionId } from "@reins/protocol";

/**
 * daemon 内部的消费者归属。请求因果用 AsyncLocalStorage 传递，会话归属用
 * 表记录；两者只服务 daemon 内部路由与诊断范围，不进入协议参数或结果。
 */
export type ConsumerScope = {
  within<T>(consumer: ConsumerContext, run: () => T): T;
  current(): ConsumerContext | undefined;
  claim(sessionId: SessionId, consumer: ConsumerContext): void;
  ownerOf(sessionId: SessionId): ConsumerContext | undefined;
  inScope(consumer: ConsumerContext, sessionId: SessionId): boolean;
  ownerForFact(fact: unknown): ConsumerContext | undefined;
};

export function createConsumerScope(): ConsumerScope {
  const storage = new AsyncLocalStorage<ConsumerContext>();
  const sessionOwners = new Map<SessionId, ConsumerContext>();

  return {
    within: (consumer, run) => storage.run(consumer, run),
    current: () => storage.getStore(),
    claim(sessionId, consumer) {
      // 归属由创建该会话的请求确立，后来者不能改写。
      if (!sessionOwners.has(sessionId)) {
        sessionOwners.set(sessionId, consumer);
      }
    },
    ownerOf: (sessionId) => sessionOwners.get(sessionId),
    inScope(consumer, sessionId) {
      const owner = sessionOwners.get(sessionId);
      return owner === undefined || owner === consumer;
    },
    ownerForFact(fact: unknown) {
      const causedByRequest = storage.getStore();
      if (causedByRequest !== undefined) return causedByRequest;
      if (typeof fact !== "object" || fact === null) return undefined;
      const sessionId = (fact as { sessionId?: unknown }).sessionId;
      return typeof sessionId === "string"
        ? sessionOwners.get(sessionId as SessionId)
        : undefined;
    },
  };
}
