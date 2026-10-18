#!/usr/bin/env node
import { connect as connectSocket, type Socket } from "node:net";

import { resolveReinsSocketPath } from "@reins/transport";

import { openLocal } from "./index.ts";

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(path);
    const onError = (error: Error): void => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.destroy();
      reject(error);
    };
    const onConnect = (): void => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function bridgeStdio(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onInputEnd = (): void => {
      socket.end();
    };
    const onInputClose = (): void => {
      if (!process.stdin.readableEnded) socket.end();
    };
    const onSocketClose = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onStdoutError = (error: Error): void => finish(error);
    const onSignal = (signal: NodeJS.Signals): void => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      finish();
    };

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      process.stdin.unpipe(socket);
      process.stdin.pause();
      socket.unpipe(process.stdout);
      if (!socket.destroyed) socket.destroy();
      if (!process.stdout.destroyed && !process.stdout.writableEnded)
        process.stdout.end();
      process.stdin.removeListener("end", onInputEnd);
      process.stdin.removeListener("close", onInputClose);
      process.stdin.removeListener("error", onError);
      socket.removeListener("close", onSocketClose);
      socket.removeListener("error", onError);
      process.stdout.removeListener("error", onStdoutError);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      if (error === undefined) resolve();
      else reject(error);
    }

    process.stdin.on("end", onInputEnd);
    process.stdin.on("close", onInputClose);
    process.stdin.on("error", onError);
    socket.on("close", onSocketClose);
    socket.on("error", onError);
    process.stdout.on("error", onStdoutError);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.stdin.pipe(socket, { end: false });
    socket.pipe(process.stdout, { end: false });
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  process.stdin.pause();
  let startupConnection: Awaited<ReturnType<typeof openLocal>> | undefined;
  let socket: Socket | undefined;
  try {
    startupConnection = await openLocal({
      consumerContext: "reins-control-entry",
      env: process.env,
    });
    socket = await openSocket(resolveReinsSocketPath({ env: process.env }));
    startupConnection.close();
    startupConnection = undefined;
    await bridgeStdio(socket);
  } finally {
    startupConnection?.close();
    if (socket !== undefined && !socket.destroyed) socket.destroy();
  }
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  process.stderr.write(`Reins control entry failed${detail}\n`);
  process.exitCode = 1;
}
