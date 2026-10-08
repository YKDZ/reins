# Reins

一个刻意保持简单的 Harness 控制面。

## 假设

本项目的意义建立在以下假设上：

1. 每个模型都有 “最适合” 自己的 Harness
2. 1 所导致的同模型下 Agent 能力的差异是足够大以至于有实际意义的
3. 只有模型训练方才能产出 “最佳” 的那个 Harness

另外，若 [ACP v2](https://agentclientprotocol.com/protocol/v2/overview) 退出草稿阶段而趋于稳定，且主流训练方 Harness 皆完成对其的兼容，则本项目将退化为单纯的协议包装层。

## 介绍

本项目的产生动机和具体设计则是来自以下需求和痛点：

1. 各家模型商都有自己的 Harness 和订阅套餐，且它们都不太喜欢自己的订阅被转换为 API
2. 我有复数个上述套餐，默认情况下却只能分开使用它们
3. 我的工作流是基于 Subagent 系统的，用一个旗舰模型 Agent 控制若干能力高低不同的模型 Agent，而因为 1 和 2，我只能在单一 Harness 内用原生能力派生 Subagent

因此需要这样一个控制面，用四个核心动作抽象任意 Harness 上的 Agent 会话：

| 动作          | 语义                                                     |
| ------------- | -------------------------------------------------------- |
| **spawn**     | 创建会话并启动首个回合                                   |
| **send**      | 向会话注入消息；busy 时在消息边界注入，idle 时触发新回合 |
| **wait**      | 等待一个或多个会话的回合完成                             |
| **interrupt** | 停止进行中的回合，保留会话；不携带模型可见消息           |

以上动作被一个针对 Agent 精心设计的 CLI 暴露给消费者。当然核心模型和 Harness 适配器等与具体的控制面是解耦的，因此任何暴露形态（MCP、自有应用等）都是可以实现的。

保持核心动作简单是兼容各家 Harness 的前提，因为它们在设计细节上区别繁多，对外暴露的可编程能力更是参差不齐。

## 发行与验收

- `pnpm deployment`：构建发行所需包，生成并校验正式发行产物（`.artifacts/release`，恰好一个 tarball 与 `SHA256SUMS`），随后对发行包执行 npm 干净安装 smoke。
- npm smoke 的进程生命周期（启动、就绪等待、超时、停止）由 `scripts/packed-cli-fixtures/` 的窄共享夹具承担，后续在 Docker 内消费同一正式发行包的 smoke 复用同一接缝；每个真实进程的完整 stdout/stderr 自启动起落盘，逐项事实（退出码、信号、超时、停止与已安装 SDK/额外运行时身份）按行记录。日志与事实写入 `REINS_SMOKE_EVIDENCE_DIR`（默认 `.artifacts/packed-cli-smoke`）；生命周期清理失败保留为原始事实并以非零退出报告，不被记成通过。
- `pnpm acceptance:prepare`：在发行校验之后，为本次正式 tarball 生成独立于源码 workspace 的验收输入组（`.artifacts/acceptance-input`）：候选与校验文件、消费者清单与最小 pnpm 配置、由项目固定 pnpm 原生生成的消费者锁，绑定组内文件摘要与 pnpm 版本的 `input.json`，以及本场景选定文件按仓库内相对结构打包成的 `fixtures/`。
- `pnpm acceptance:round <group-dir> <adapter-module> <evidence-dir>`：把输入组当纯外部素材，在临时目录中用固定 pnpm 冻结安装候选，再以已安装 CLI 显式启动 daemon、经 Unix socket 走完真实 worker/session 回合。可控 adapter 只通过现有的 `REINS_ADAPTERS_MODULE` 注册表接缝替换，入口只读输入组，安装/socket/state/子进程由入口拥有并在结束前回收，逐项事实与完整日志写入调用方指定的证据目录。
- 组内入口自足，不读宿主源码树：`node <group>/fixtures/scripts/check-pnpm-consumer-round.ts <group> <group>/fixtures/scripts/packed-cli-fixtures/simulated-adapter.ts <evidence-dir>`。后续在容器内重放该场景时使用同一输入组与同一命令；它是场景自身的显式输入与入口，由测试平台 `run` 管理环境与回收。
- 同一输入组可整体移动到不同路径并用 `pnpm install --frozen-lockfile` 重放，锁保持不变；重新在线解析生成新锁代表新的安装条件。Qoder SDK 安装脚本额外下载的厂商运行时不受包锁冻结，验收时记录其实际版本与内容摘要。

- `pnpm check`：通过 Turbo 执行静态检查、单元测试、CLI e2e 和不使用缓存的真实 Docker 验收；自动构建并校验正式包、执行 npm smoke、准备消费者输入组。需要可运行特权容器的 Docker。
- Linux 快速测试将可丢弃的运行目录放在 `/dev/shm`，避免宿主磁盘同步写入延迟耗尽进程协议的超时；安装目录与临时 checkout 使用普通临时目录，Docker 实机状态和证据使用 `.artifacts`。
- `pnpm exec turbo run test:docker --filter=@reins/test-platform`：只运行正式候选与平台验收的完整依赖链，CI 使用相同入口。已保存输入组的重放直接调用组内入口，不重新生成锁。
