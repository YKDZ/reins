import { runCli, runRound } from "../packages/test-platform/src/index.ts";

// VFS 下的单条原生 Docker 操作沿已验证平台 launcher 的运行条件。
// 场景整体预算仍由调用方现有 --timeout-ms 独立传入。
process.exitCode = await runCli(process.argv.slice(2), {
  runRound: (options, request) =>
    runRound({ ...options, timeoutMs: 1_200_000 }, request),
});
