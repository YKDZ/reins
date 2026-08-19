import { describe, expect, test } from "vitest";

import { createAsyncQueue } from "#/async-queue";

describe("createAsyncQueue", () => {
  test("先 push 后迭代按序产出，end 后结束", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.end();

    const out: number[] = [];
    for await (const item of queue) out.push(item);
    expect(out).toEqual([1, 2]);
  });

  test("迭代中 push 与 end 都安全", async () => {
    const queue = createAsyncQueue<number>();
    const out: number[] = [];
    const consume = (async () => {
      for await (const item of queue) out.push(item);
    })();

    queue.push(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    queue.push(4);
    queue.end();
    await consume;
    expect(out).toEqual([3, 4]);
  });
});
