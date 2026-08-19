export type AsyncQueue<T> = AsyncIterable<T> & {
  push(item: T): void;
  end(): void;
};

// 单生产者单消费者的异步队列：先 push 后迭代、迭代中 push、end 三种时序都安全。
export function createAsyncQueue<T>(): AsyncQueue<T> {
  const buffer: T[] = [];
  const waiters: Array<(result: IteratorResult<T, undefined>) => void> = [];
  let ended = false;

  return {
    push(item) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ value: item, done: false });
      } else {
        buffer.push(item);
      }
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiters) waiter({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          const item = buffer.shift();
          if (item !== undefined) {
            return Promise.resolve({ value: item, done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}
