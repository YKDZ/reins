// 既有 daemon 注册表的唯一行为替身；准备票不允许它创建 worker。
import type { AdapterDriverFactory, HarnessCapability } from "@reins/protocol";

const driverFactory: AdapterDriverFactory = () => {
  throw new Error("Preparation must not create a worker");
};
const capabilities = async (): Promise<HarnessCapability> => ({
  harness: "codex",
  models: [],
});
export default new Map([["codex", { capabilities, driverFactory }]]);
