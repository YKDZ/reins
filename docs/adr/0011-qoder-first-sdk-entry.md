# qoder 先行与 SDK 入口策略

第一个 adapter 选 qoder，适配对象为 CN 版 `qodercli`。入口用官方进程内 SDK `@qodercn-ai/qodercn-agent-sdk`，以 `qodercliAuth()` 复用本机 `qodercli` 登录态；CLI 子进程解析只作 fallback 与录制 fixture 的来源，不主用。该 SDK 本身就是围绕 `qodercli` 子进程的双向 JSONL 协议包装，进程内与子进程在此重合，不存在额外进程协议。

`thinking_delta` 不进领域事件，只落 adapter 调试 transcript（与 ADR-0004"原生输出不进事件流"一致）。能力矩阵暂不实现：qoder 过 live smoke 即视为支持全部七动作，等第二个能力有差异的 adapter 出现再设计声明面。

live smoke 放在 `adapters/qoder` 的 vitest 套件内，以 `REINS_LIVE_SMOKE=1` 显式 gating、默认 skip，不污染 `pnpm test`；用一条覆盖流式输出、一次工具调用与一次权限确认的短任务，断言归一化事件序列与 `wait` 终态。前置条件为本机 `qodercli` 登录态可用，最终不降级判定以 live smoke 为准。

产品交付为单一 `@reins/cli` 交付物，但打包拼接只发生在发布阶段：架构上各包保持独立边界、干净拼接，单仓内 `@reins/core` / `@reins/protocol` / `adapters/*` 的开发结构不变。
