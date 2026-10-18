import {
  type ConnectOptions,
  type ControlByteChannel,
  type ControlRuntimeTarget,
} from "@ykdz/reins-sdk";

declare const target: ControlRuntimeTarget;
declare const channel: ControlByteChannel;

// @ts-expect-error 注入连接不能同时指定本地 socket。
const mixedConnection: ConnectOptions = {
  consumerContext: "packed-consumer",
  socketPath: "/run/reins.sock",
  runtimeTarget: target,
  openControlChannel: async () => channel,
};

// @ts-expect-error 已注入通道需要独立诊断流与可等待终止结果。
const incompleteChannel: ControlByteChannel = {
  readable: (async function* () {})(),
  write: async (_bytes: Uint8Array) => {},
  close: async () => {},
};

function connectGeneric<const Options extends ConnectOptions>(
  options: Options,
) {
  return options;
}

const conflictingVariable = {
  consumerContext: "packed-consumer",
  socketPath: "/run/reins.sock",
  runtimeTarget: target,
  openControlChannel: async () => channel,
};
// @ts-expect-error 泛型变量推导也必须保留连接方式互斥。
connectGeneric(conflictingVariable);

void mixedConnection;
void incompleteChannel;
