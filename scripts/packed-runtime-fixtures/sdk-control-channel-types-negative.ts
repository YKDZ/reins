import {
  connect,
  openControl,
  type ConnectOptions,
  type ControlByteChannel,
  type OpenControlOptions,
  type ControlRuntimeTarget,
} from "@ykdz/reins-sdk";

declare const target: ControlRuntimeTarget;
declare const channel: ControlByteChannel;

const injectedConnection = {
  consumerContext: "packed-consumer",
  runtimeTarget: target,
  openControlChannel: async () => channel,
};
// @ts-expect-error connect 只连接既有本地 socket。
void connect(injectedConnection);

const socketConnection = {
  consumerContext: "packed-consumer",
  socketPath: "/run/reins.sock",
};
// @ts-expect-error 公开注入入口只能接收目标描述和字节 opener。
void openControl(socketConnection);

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

const injectedVariable = {
  consumerContext: "packed-consumer",
  runtimeTarget: target,
  openControlChannel: async () => channel,
};
// @ts-expect-error 泛型变量不能把注入配置传给本地 connect。
connectGeneric(injectedVariable);

const conflictingVariable = {
  consumerContext: "packed-consumer",
  socketPath: "/run/reins.sock",
  runtimeTarget: target,
  openControlChannel: async () => channel,
};
function openControlGeneric<const Options extends OpenControlOptions>(
  options: Options,
) {
  return options;
}
// @ts-expect-error 泛型变量不能向注入入口混入本地 socket。
openControlGeneric(conflictingVariable);

void incompleteChannel;
void openControl;
