// 接口层核心：七动作状态机与事件总线。
export {
  createSessionMachine,
  type SessionMachine,
  type SessionIdentity,
} from "./session-machine.ts";
export {
  createEventBus,
  type EventBus,
  type ListenerErrorSink,
} from "./event-bus.ts";
export {
  noopDiagnosticEmitter,
  type DiagnosticEmitter,
} from "./diagnostic-emitter.ts";
export type { SessionId } from "@reins/protocol";
