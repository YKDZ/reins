# 统一控制面：缺口补查

调研日期：2026-08-18。本文补充 `docs/research/acp-capability.md` 与 `docs/research/harness-landscape.md`，只写缺口与更正，不重复既有内容。来源以官方规范站、官方仓库、官方文档为准。

## ACP 版本现状（对既有笔记的更正）

- Agent Client Protocol（ACP）稳定版仍是 **v1**；**v2 处于 Draft**（2026-07-20 发布），官方要求按连接协商版本，并用 feature flag 门控 v2 直至稳定。
- v2 最关键的语义变化与控制面直接相关：`session/prompt` 的响应只表示"已接受"，不再代表回合结束；前台工作进展与结束改由 `state_update`（running / idle / requires_action）+ `stopReason` 表达。这让"等待终态"有了比 v1 更干净的原语，但 v2 仍然**没有任何 spawn / subagent / 进程级 kill / 阻塞 wait**。
- 已稳定的小能力：`$/cancel_request`（按请求 ID 取消）、`session/cancel`、`session/resume`、`session/list`、`session/close`、`session/delete`、`session/request_permission`、`usage_update`。
- v2 移除了 v1 的 Client 侧文件系统与终端执行面（`fs/*`、`terminal/*`），Agent 需要的工具改由 Client 提供的 MCP server 承载。
- 生态：官方 Rust 与 TypeScript SDK 已达 1.0；ACP Registry 上线；Transports Working Group 在推进远程传输（WebSocket / HTTP）的 Draft RFD。

来源：

- https://agentclientprotocol.com/updates
- https://agentclientprotocol.com/announcements/acp-v2-draft
- https://agentclientprotocol.com/protocol/v2/migration
- https://agentclientprotocol.com/protocol/v2/overview

## 同名缩写的区分

"ACP" 至少指两个协议，调研与对外文档必须写全称：

- **Agent Client Protocol**（Zed 发起，agentclientprotocol.com）：Client ↔ Agent 的会话协议，即本项目讨论的 ACP。
- **Agent Communication Protocol**（IBM，agent-to-agent 消息语义）：IETF 草案与 A2A 生态中另有引用，与前者无关。

来源：

- https://agentclientprotocol.com/
- https://a2a-protocol.org/latest/
- https://datatracker.ietf.org/doc/html/draft-hood-agtp-composition-01

## A2A 定位（复核）

A2A 官方明确它不是 sub-agent 协议、也不是工具调用协议：它面向"互相不透明的独立 agent 应用"之间的任务委托，不定义进程级生命周期。

来源：https://a2a-protocol.org/latest/（"What A2A Is Not"）

## Qoder CN CLI 可驱动性（新补）

- 命令为 `qoderclicn`（阿里云 Lingma 的 Qoder CN CLI）。运行模式：TUI；Print 模式（`-p` / `--print`，`--output-format text|json|stream-json`）；MCP 服务模式（`qoderclicn mcp serve`）；ACP 接入（可连 Zed 等 ACP 编辑器）；Remote Control（daemon 模式，支持无头远程控制）。
- 会话：`-c` 继续上次会话、`-r <id>` 恢复指定会话、`/resume`；`--worktree [name]` 可在独立 git worktree 里运行会话。
- 子代理：原生支持，`/agents` 面板创建与管理；每个子代理有独立上下文、工具集、模型、权限模式与运行限制。
- 权限：`default / accept_edits / auto / bypass_permissions(yolo) / dont_ask`；**headless（-p）下 ask 一律转 deny**；SDK（stdio 协议）通过 `canUseTool` 回调让宿主决策；ACP 下通过 `requestPermission`；另有 PreToolUse / PermissionRequest 两类 Hook。
- 对 adapter 的含义：一次性任务可用 print / stream-json；多轮对话用 `-r` 恢复；权限敏感的 worker 应走 SDK 的 `canUseTool` 或显式配置 auto / dont_ask，而不是默认模式。
- 开源侧：QwenLM/qwen-code 自 2026-08 起支持安装 Qoder 插件与 Agent Plugins v1 标准包（v0.21.8-nightly，PR #8661）。

来源：

- https://help.aliyun.com/zh/lingma/qodercli-cn/product-overview/what-is-qoder-cli-cn
- https://help.aliyun.com/zh/lingma/using-the-cli
- https://github.com/QwenLM/qwen-code/releases/tag/v0.21.8-nightly.20260810.55e20db328
- https://github.com/QwenLM/qwen-code/pull/8661

## 社区先例：把进程级 spawn 架在 ACP 之上

- `@harness-desktop/dsh-subagent-acp`：一个 ACP provider，把每个 subagent 放进独立子进程，按 spawn → ACP initialize → newSession 驱动；进程生命周期由 provider 自己管理。这印证了"会话语义用 ACP、进程语义自己管"的分层可行。
- `pi-subagents`（@clanker-code/pi-subagents）：为 pi 增加 SpawnCapable 接口，以及 spawn / stop / abort 的标准化 RPC 信封。
- openclaw（openclaw/openclaw）：spawn ACP server，握手失败时 TERM 升级到 KILL 回收；另有 Codex 原生 subagent 任务的相关修复。

来源：

- https://www.npmjs.com/package/@harness-desktop/dsh-subagent-acp
- https://cdn.jsdelivr.net/npm/@clanker-code/pi-subagents@0.11.1/CHANGELOG.md
- https://github.com/openclaw/openclaw/pull/117901

## 2026 年标准动向

- IETF 草案 draft-hood-agtp-composition（00 / 01）提出以 AGTP 作传输基座，把 MCP / A2A / ACP（通信）列为其上的 Agent Group Messaging Protocol，并讨论外部身份提供者与 HTTP 网关。仍是早期草案，不影响本项目结论。
- 不改变既有判断：没有任何公开协议原生覆盖"进程级 spawn / kill / wait + 父子 agent 关系"，这部分仍须自研；ACP 适合作为与 ACP-native harness（及编辑器）互操作的 adapter 之一。

来源：

- https://datatracker.ietf.org/doc/html/draft-hood-agtp-composition-01
- https://www.ietf.org/archive/id/draft-hood-agtp-composition-00.html

## 结论

1. 内部动作面（spawn / send / wait / kill / list + 事件）在 ACP v1 稳定版与 v2 Draft 中都不存在，必须由控制面自己定义；ACP 可作为适配层的一种协议，而非内部协议。
2. Qoder CN CLI 的可驱动性足够进入 v1 adapter（print / stream-json + 会话恢复 + SDK canUseTool + MCP / ACP 入口）。
3. 认证、权限模式等 harness 特有面保持交给 harness 自己处理，与设计约束一致。

## 工具动词粒度：interrupt 与 kill 是否分开

问题：把"停止回合"（可恢复）与"彻底清理会话"（不可逆）做成两个动词，还是单动词 + 枚举参数，哪个更容易被 agent 区分理解？

一手依据：

- OpenAI 官方 Function calling 指南：函数要"obvious and intuitive"（最少惊讶原则）；用 enum 让非法状态不可表达；起始可用函数数尽量少（软上限 <20）；总是一起顺序调用的函数可以合并。
- Anthropic 官方《Writing effective tools for agents》：每个工具要有清晰、独特的目的；工具功能重叠或目的含糊时 agent 会混淆；工具过多或重叠会分散 agent 的策略。
- 各 harness 的实际工具面：Codex 用独立动词（本环境工具面 `interrupt_agent`；官方文档把 steer / stop / close 列为三种不同控制）；Claude Code team-mode 用独立工具 TaskStop / TaskOutput / SendMessage / Agent（经 pi 官方 parity 表核实）；pi team-mode 同样用独立的 `task_stop` 等。

结论：支持双动词。理由：interrupt 与 kill 的后果不对称（可恢复 vs 不可逆销毁）、适用前提不同（仅 busy vs 任意状态），正是"目的不同"的典型情形；三家 harness 全部采用独立动词；总工具数只有 6-7 个，远低于"工具过多"的担忧区间。若坚持单动词 + 参数，必须把 mode 设为必填 enum，但不可逆操作独立命名带来的收益仍大于省下的上下文。

来源：

- https://platform.openai.com/docs/guides/function-calling
- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://developers.openai.com/codex/subagents
- https://pi.dev/packages/pi-mono-team-mode
