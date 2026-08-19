import type { DomainEvent } from "@reins/protocol";

// 订阅者抛错的出口：宿主决定如何记录，缺省只落 console。
export type ListenerErrorSink = (error: unknown, event: DomainEvent) => void;

export type EventBus = {
  // 发布一条或一组事件；在 transaction 的 run 内发布会进当前帧。
  publish(event: DomainEvent | readonly DomainEvent[]): void;
  // 先执行 run，期间发布的事件收集进帧：成功则先发 lead 再发收集事件，
  // 抛错则丢弃整个帧并原样上抛。
  transaction(lead: readonly DomainEvent[], run: () => void): void;
  subscribe(listener: (event: DomainEvent) => void): () => void;
};

type Frame = { readonly events: DomainEvent[] };

export function createEventBus(options: {
  apply: (event: DomainEvent) => void;
  onListenerError?: ListenerErrorSink;
}): EventBus {
  const listeners = new Set<(event: DomainEvent) => void>();
  const frames: Frame[] = [];
  const queue: DomainEvent[] = [];
  let draining = false;

  function reportListenerError(error: unknown, event: DomainEvent): void {
    if (options.onListenerError !== undefined) {
      options.onListenerError(error, event);
    } else {
      console.error("事件订阅者抛错", error, event);
    }
  }

  function dispatch(event: DomainEvent): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (error) {
        reportListenerError(error, event);
      }
    }
    options.apply(event);
  }

  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const event = queue.shift();
        if (event !== undefined) dispatch(event);
      }
    } finally {
      draining = false;
    }
  }

  function commit(events: readonly DomainEvent[]): void {
    const parent = frames[frames.length - 1];
    if (parent !== undefined) {
      parent.events.push(...events);
    } else {
      queue.push(...events);
      drain();
    }
  }

  return {
    publish(event) {
      const events = Array.isArray(event) ? event : [event];
      const frame = frames[frames.length - 1];
      if (frame !== undefined) {
        frame.events.push(...events);
      } else {
        queue.push(...events);
        drain();
      }
    },
    transaction(lead, run) {
      const frame: Frame = { events: [] };
      frames.push(frame);
      try {
        run();
      } catch (error) {
        frames.pop();
        throw error;
      }
      frames.pop();
      commit([...lead, ...frame.events]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
