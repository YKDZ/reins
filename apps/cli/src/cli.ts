#!/usr/bin/env node

import { main } from "./main.ts";

async function flushIfPending(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength > 0 && !stream.destroyed) {
    await Promise.race([
      new Promise<void>((resolve) => stream.once("drain", resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
}

// CLI 是拉起常驻 daemon 的短命进程：main 完成后显式退出，
// 避免后台连接 / 子进程句柄拖住事件循环（管道场景）。
void main(process.argv.slice(2)).then(async (code) => {
  await flushIfPending(process.stdout);
  await flushIfPending(process.stderr);
  process.exit(code);
});
