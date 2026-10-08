import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 恢复所需清单必须逐项 fsync，慢速文件系统上单条用例可能超过默认 5 秒。
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
