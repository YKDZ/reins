# ACP 能力评估（一手调研）

调研日期：2026-08-18。来源以 ACP 官方规范站、官方 GitHub 仓库、官方 SDK、Zed 官方博客为准。

## 结论先行

ACP（Agent Client Protocol）是 **client ↔ agent 的会话协议**：JSON-RPC 2.0；稳定版为 v1，v2 于 2026-07-20 进入 Draft（本文方法表取自 v2 文档面）。它原生覆盖了"创建会话（session/new）、发送消息（session/prompt）、取消（session/cancel）、关闭（session/close）、恢复/列出/删除会话、流式事件（session/update）、权限确认（session/request_permission）"。

但 ACP **不覆盖进程级生命周期**：没有"spawn 子代理进程、kill 进程、wait 终态、父子代理关系"这些概念（v2 schema 中检索不到 `subagent`/`spawn`）。协议假设 agent 由 client 作为子进程拉起（"Agents typically run as subprocesses of the Client"），进程的创建、强杀、等待都由 client 自己负责。

因此对"核心 agent 用原生 subagent 方式驱动其他 harness"这个目标：**ACP 可以作为控制面与 harness adapter 之间的会话协议底座，但不能单独满足需求**——spawn/kill/wait 和父子关系必须由控制面自己实现，或用 ACP 的扩展机制补齐（扩展机制不做跨实现互操作）。

## 定位与通信模型

- 标准化"代码编辑器（Client）与编码 agent（Agent）"之间的通信；Agent 通常作为 Client 的子进程运行。
- JSON-RPC 2.0：请求-响应（方法）+ 单向通知。
- 会话（Session）是独立的对话上下文：每个会话有自己的历史与状态，客户端可同时与多个会话交互。
- 传输以 stdio 为主（agent 作为 client 子进程），会话内可挂接 MCP 服务器（stdio / HTTP）。

来源：
- https://agentclientprotocol.com/protocol/v2/overview
- https://agentclientprotocol.com/protocol/v2/session-setup

## 方法面清单

| 方法 | 方向 | 语义 | 对应需求 |
|---|---|---|---|
| initialize | Client → Agent | 协议版本与能力协商 | 建连 |
| auth/login、auth/logout | Client → Agent | 可选认证面（Agent 声明 authMethods 时必选） | 认证 |
| session/new | Client → Agent | 创建新会话，返回 sessionId | create（会话级） |
| session/list | Client → Agent | 列出已知会话（可过滤/分页） | list |
| session/resume | Client → Agent | 恢复会话，可选 replayFrom 重放历史 | 恢复 |
| session/close | Client → Agent | 取消进行中工作并释放会话资源 | kill（会话级） |
| session/delete | Client → Agent | 从 session/list 删除会话（可选能力） | 清理 |
| session/prompt | Client → Agent | 发送用户消息；仅确认"已接受" | send |
| session/cancel | Client → Agent（通知） | 停止模型请求与工具调用，Agent 回报 idle+cancelled | cancel |
| session/update | Agent → Client（通知） | user/agent/thought 消息、chunk 流、state_update、plan_update、tool_call_update、usage_update、terminal_output_chunk 等 | stream |
| session/request_permission | Agent → Client | 工具/命令执行前请求授权 | permission |
| elicitation/create | Agent → Client | 向用户请求结构化信息（可选） | 交互 |

来源：
- https://agentclientprotocol.com/protocol/v2/initialization
- https://agentclientprotocol.com/protocol/v2/prompt-lifecycle
- https://cdn.jsdelivr.net/gh/agentclientprotocol/agent-client-protocol@main/docs/protocol/v2/schema.mdx

## 能力矩阵：ACP vs 控制面需求

| 需求 | ACP 覆盖度 | 说明 |
|---|---|---|
| create（创建子代理） | 部分 | `session/new` 可创建独立会话；但没有"子代理/父子线程"语义，父子关系需控制面维护 |
| send（发消息） | 原生 | `session/prompt`；多个会话可并行 |
| kill（杀进程/中止） | 部分 | `session/cancel` + `session/close` 是协议内最接近的取消/关闭；进程级强杀不在协议内，由 client 负责 |
| wait（等待终态） | 部分 | 无阻塞 wait 方法；标准机制是订阅 `session/update` 的 `state_update: idle` + `stopReason` |
| stream（流式输出） | 原生 | 消息 chunk、工具输出 chunk、终端输出 chunk、usage_update |
| permission（权限） | 原生 | `session/request_permission`、elicitation |
| 父子代理关系/线程树 | 缺失 | schema 中无 subagent/spawn 概念 |
| 跨 agent 编排 | 缺失 | ACP 只管单个 Client 与多个 Agent 的会话，不管"核心 agent 编排其他 agent" |

## 扩展机制

- `_meta` 字段：任何类型可携带自定义元数据。
- 下划线前缀方法/通知（如 `_zed.dev/workspace/buffers`）：实现自定义请求，不认识则返回 Method not found。
- 初始化时通过 capabilities 的 `_meta` 广告扩展能力。

扩展是单向的、实现绑定的，**不保证跨实现互操作**。

来源：https://agentclientprotocol.com/protocol/extensibility

## 成熟度、治理与生态

- Apache-2.0（ACP 组织内仓库统一），Zed 发起，无 CLA。
- 协议版本为整数主版本，v2 为当前文档默认版本；有官方 Rust SDK 与 TypeScript SDK（`@agentclientprotocol/sdk`）。
- 生态（2025-10 Zed 官方博客）：
  - 客户端：Zed、Neovim（CodeCompanion、avante.nvim）、Emacs（agent-shell）、marimo、JetBrains。
  - Agent：Gemini CLI（参考实现）、Claude Code（Zed 的 SDK adapter）、Codex（Zed 开源的 codex-acp adapter）、Goose（原生实现）、社区 Cursor adapter。
- 治理文档：docs/community/governance.mdx。

来源：
- https://github.com/agentclientprotocol/agent-client-protocol/blob/main/Cargo.toml
- https://github.com/agentclientprotocol/agent-client-protocol/blob/700e441e/docs/community/governance.mdx
- https://zed.dev/blog/acp-progress-report
- https://zed.dev/blog/codex-is-live-in-zed

## 对统一控制面的启示

1. ACP 很适合做"控制面 ↔ 单 harness adapter"之间的会话协议：一个控制面以 ACP Client 身份连接多个 agent 进程，天然获得会话抽象、流式事件、权限、恢复。
2. 但"核心 agent 像原生 subagent 一样调用其他 agent（spawn/followup/send/interrupt/wait/list）"所需的部分——进程 spawn、强杀、等待、父子关系——**必须由控制面自身实现**，ACP 不提供。
3. 用 ACP 下划线扩展补 spawn/kill/wait 可以做到，但那是私有协议，失去互操作意义；更务实的做法是控制面定义自己的统一工具面，ACP 作为其中一个 adapter 的协议（或作为控制面与自研 agent 之间的协议）。
