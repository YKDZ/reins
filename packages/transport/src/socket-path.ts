import { tmpdir } from "node:os";
import { join } from "node:path";

export type SocketPathEnvironment = {
  readonly REINS_SOCKET?: string;
  readonly XDG_RUNTIME_DIR?: string;
  readonly HOME?: string;
};

// 内部协议的 v1 socket 位置契约：REINS_SOCKET 显式覆盖，
// 缺省 $XDG_RUNTIME_DIR/reins.sock，再回退 ~/.reins/reins.sock。
export function resolveReinsSocketPath(options?: {
  readonly env?: SocketPathEnvironment;
  readonly home?: string;
}): string {
  const env = options?.env ?? process.env;
  if (env.REINS_SOCKET !== undefined && env.REINS_SOCKET !== "") {
    return env.REINS_SOCKET;
  }
  if (env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== "") {
    return join(env.XDG_RUNTIME_DIR, "reins.sock");
  }
  const home = options?.home ?? env.HOME;
  if (home !== undefined && home !== "") {
    return join(home, ".reins", "reins.sock");
  }
  return join(tmpdir(), "reins.sock");
}
