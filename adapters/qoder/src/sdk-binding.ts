import { qodercliAuth, query } from "@qodercn-ai/qodercn-agent-sdk";

import type { QoderSdk } from "./sdk-seam.ts";

// 真实绑定：进程内 SDK + 复用本机 qodercli 登录态（ADR-0011）。
export function createRealQoderSdk(): QoderSdk {
  return {
    query({ prompt, options }) {
      return query({ prompt, options: { ...options, auth: qodercliAuth() } });
    },
  };
}
