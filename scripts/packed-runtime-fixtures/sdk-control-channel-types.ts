import {
  connect,
  openControl,
  parseRuntimeScopeId,
  type ConnectOptions,
  type OpenControlOptions,
  type ControlByteChannel,
  type ControlChannelOpener,
  type ControlRuntimeTarget,
} from "@ykdz/reins-sdk";

async function* emptyBytes(): AsyncGenerator<Uint8Array> {}

const target: ControlRuntimeTarget = {
  command: "/opt/reins/node/bin/node",
  args: ["/opt/reins/package/control-entry.js"],
  runtimeScopeId: parseRuntimeScopeId("550e8400-e29b-41d4-a716-446655440000"),
};
const byteChannel: ControlByteChannel = {
  readable: emptyBytes(),
  diagnostics: emptyBytes(),
  async write(_bytes) {},
  async close() {},
  terminated: Promise.resolve({ exitCode: 0, signal: null }),
};
const opener: ControlChannelOpener = async (runtime, signal) => {
  void runtime.command;
  void signal.aborted;
  return byteChannel;
};

const injectedOptions: OpenControlOptions = {
  consumerContext: "packed-consumer",
  runtimeTarget: target,
  openControlChannel: opener,
};
const socketOptions: ConnectOptions = {
  consumerContext: "packed-consumer",
  socketPath: "/run/reins.sock",
  runtimeScopeId: target.runtimeScopeId,
};

function connectGeneric<const Options extends ConnectOptions>(
  options: Options,
) {
  return connect(options);
}

function openControlGeneric<const Options extends OpenControlOptions>(
  options: Options,
) {
  return openControl(options);
}

void injectedOptions;
void socketOptions;
void connectGeneric;
void openControlGeneric;
