// 共享进程夹具的结果事实类型：把「进程实际怎样结束」与「夹具怎么停止它」分开记录。
export type ProcessExitReason =
  // 子进程在被施加任何停止动作之前就自己退出了。
  | "exited"
  // SIGTERM 在宽限期内关闭了子进程。
  | "terminated"
  // SIGTERM 宽限期耗尽后由 SIGKILL 强制停止；clean=false 表达这不是产品自行停止。
  | "sigkill_escalated"
  // spawn 本身失败（例如可执行文件无法启动），没有可信的 exit code。
  | "spawn_error";

export type ProcessExitFact = {
  readonly reason: ProcessExitReason;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  // 超时事实：就绪等待超时（daemon.startupTimedOut）或 SIGTERM 宽限期超时。
  readonly timedOut: boolean;
  // 停止动作之后子进程是否仍在运行（生命周期清理失败的原始事实）。
  readonly stillRunning: boolean;
};

export type LoggedCommandResult = {
  readonly exit: ProcessExitFact;
  readonly stdout: string;
  readonly stderr: string;
  // 完整 stdout/stderr 自进程启动即流式写入的日志路径（含失败输出）。
  readonly logPath: string;
};

export type DaemonHandle = {
  readonly label: string;
  readonly logPath: string;
  readonly socketPath: string;
  // 就绪等待超时后为 true：进程可能仍在运行，由 stopDaemon 兜底停止并保留事实。
  readonly startupTimedOut: boolean;
  readonly isRunning: () => boolean;
  readonly stop: (graceMs: number) => Promise<ProcessExitFact>;
};

export type StartDaemonOptions = {
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly socketPath: string;
  readonly logPath: string;
  readonly readyTimeoutMs: number;
  readonly pollIntervalMs?: number;
};
