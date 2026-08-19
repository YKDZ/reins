import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createEventBus } from "#/event-bus";

function makeEvent(seq: number): DomainEvent {
  return {
    type: "text.delta",
    sessionId: "s1",
    turnId: "s1:t1",
    messageId: `m${seq}`,
    delta: `${seq}`,
  };
}

function deltas(events: DomainEvent[]): string[] {
  return events
    .filter((event) => event.type === "text.delta")
    .map((event) => (event.type === "text.delta" ? event.delta : ""));
}

describe("event-bus", () => {
  test("publish 同步分发：先通知订阅者，再折叠状态", () => {
    const order: Array<["notify" | "apply", number]> = [];
    const bus = createEventBus({
      apply: (event) =>
        order.push(["apply", Number((event as { delta: string }).delta)]),
    });
    bus.subscribe((event) =>
      order.push(["notify", Number((event as { delta: string }).delta)]),
    );

    bus.publish(makeEvent(1));

    expect(order).toEqual([
      ["notify", 1],
      ["apply", 1],
    ]);
  });

  test("publish 数组按序折叠", () => {
    const applied: DomainEvent[] = [];
    const bus = createEventBus({ apply: (event) => applied.push(event) });

    bus.publish([makeEvent(1), makeEvent(2)]);

    expect(deltas(applied)).toEqual(["1", "2"]);
  });

  test("transaction 提交：先导事件在前，run 内发布随后", () => {
    const seen: DomainEvent[] = [];
    const bus = createEventBus({ apply: (event) => seen.push(event) });

    bus.transaction([makeEvent(1)], () => {
      bus.publish(makeEvent(2));
    });

    expect(deltas(seen)).toEqual(["1", "2"]);
  });

  test("transaction 抛错：整体回滚，不发布任何事件", () => {
    const seen: DomainEvent[] = [];
    const bus = createEventBus({ apply: (event) => seen.push(event) });

    expect(() =>
      bus.transaction([makeEvent(1)], () => {
        bus.publish(makeEvent(2));
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(seen).toEqual([]);
  });

  test("嵌套 transaction：内层提交并入外层帧，内层抛错只丢内层", () => {
    const seen: DomainEvent[] = [];
    const bus = createEventBus({ apply: (event) => seen.push(event) });

    bus.transaction([makeEvent(1)], () => {
      bus.transaction([makeEvent(2)], () => {
        bus.publish(makeEvent(3));
      });
      bus.publish(makeEvent(4));
    });

    expect(deltas(seen)).toEqual(["1", "2", "3", "4"]);

    bus.transaction([makeEvent(5)], () => {
      expect(() =>
        bus.transaction([makeEvent(6)], () => {
          bus.publish(makeEvent(7));
          throw new Error("inner");
        }),
      ).toThrow("inner");
      bus.publish(makeEvent(8));
    });

    expect(deltas(seen)).toEqual(["1", "2", "3", "4", "5", "8"]);
  });

  test("订阅者抛错被隔离，其余订阅者与折叠照常", () => {
    const sink: Array<{ error: unknown; event: DomainEvent }> = [];
    const applied: DomainEvent[] = [];
    const notified: DomainEvent[] = [];
    const bus = createEventBus({
      apply: (event) => applied.push(event),
      onListenerError: (error, event) => sink.push({ error, event }),
    });
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((event) => notified.push(event));

    bus.publish(makeEvent(1));

    expect(notified).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(sink).toHaveLength(1);
    const entry = sink[0];
    if (entry === undefined) {
      throw new Error("sink 应有记录");
    }
    expect(entry.event).toEqual(makeEvent(1));
    expect(entry.error).toEqual(
      expect.objectContaining({ message: "bad listener" }),
    );
  });

  test("分发中新增订阅者不收到当前事件，退订安全", () => {
    const first: DomainEvent[] = [];
    const late: DomainEvent[] = [];
    const bus = createEventBus({ apply: () => {} });
    bus.subscribe((event) => {
      first.push(event);
      bus.subscribe((later) => late.push(later));
    });

    bus.publish(makeEvent(1));
    expect(first).toHaveLength(1);
    expect(late).toEqual([]);

    bus.publish(makeEvent(2));
    expect(late).toEqual([makeEvent(2)]);
  });

  test("apply 期间 publish 只追加，不递归、不丢事件", () => {
    const applied: number[] = [];
    let once = false;
    const bus = createEventBus({
      apply: (event) => {
        applied.push(Number((event as { delta: string }).delta));
        if (!once) {
          once = true;
          bus.publish(makeEvent(2));
        }
      },
    });

    bus.publish(makeEvent(1));

    expect(applied).toEqual([1, 2]);
  });
});
