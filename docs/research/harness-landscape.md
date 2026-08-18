# Agent Harness 可驱动性调研（一手来源）

调研日期：2026-08-18。目标：评估"核心 agent 以原生 subagent 方式（create/send/kill/wait）驱动多个 harness"的可行性。

## 结论先行

每个主流 harness 都有无头/可编程入口，但生命周期能力差异很大，且没有任何一家提供"外部进程级 spawn/kill/wait 子代理"的公开统一 API。已有的控制面尝试（Zed/ACP、Warp Oz、liteLLM LAP、agent-control）都接近但不完全等于"本地核心 agent 用原生 subagent 工具面驱动所有 harness"这一需求——自研中间层的空间是真实存在的。

## 逐 harness

### Codex（OpenAI）

- 无头入口：`codex exec [PROMPT]`，`--json` 输出 JSONL 事件流（text / exec_approval_request / apply_patch_approval_request / turn_complete / error 等）；支持 `--full-auto`、`--sandbox`、`-C <cwd>`、`--skip-git-repo-check`、`-o <file>`、`--output-schema`。
- 会话：`codex resume [--last]` 恢复交互式会话（历史存 `~/.codex/sessions/`）；`exec` 是一次性进程。
- 子代理：官方文档确认 Codex 支持 subagent workflow：主线程 spawn 并行子代理、路由 follow-up、等待结果、关闭线程；CLI 用 `/agent` 切换/检视线程；子代理继承父会话的权限模式与沙箱；自定义 agent 文件在 `~/.codex/agents/*.toml`（内置 default/worker/explorer）。本会话环境中的协作工具面（spawn_agent / send_message / followup_task / interrupt_agent / wait_agent / list_agents）即此机制的内部形态。
- 认证：ChatGPT 套餐登录（Plus/Pro/Business/Edu/Enterprise）或 API key。
- 缺口：`exec` 是一次性进程，无公开 CLI API 支持"运行中向子代理注入消息 / 外部强杀指定子代理"；该能力目前只在 Codex 内部（app / CLI / IDE）存在。

来源：
- https://raw.githubusercontent.com/openai/codex/main/README.md
- https://developers.openai.com/codex/cli/exec（内容经 https://mintlify.wiki/openai/codex/cli/exec 核验）
- https://mintlify.wiki/openai/codex/cli/resume
- https://learn.chatgpt.com/docs/agent-configuration/subagents（本环境经镜像 https://github.com/mehmetbaykar/codex-docs-skill/blob/main/skills/codex-docs/references/agent-configuration__subagents.md 核验）

### Claude Code（Anthropic）

- 无头入口：`claude -p "query"`（--print），`--output-format text|json|stream-json`；`-r/--resume <ID>` 恢复会话；`--no-session-persistence` 仅在 print 模式下有效。
- 编程接入：Claude Agent SDK（TypeScript/Python）`query()`，支持 hooks、权限回调、流式事件。
- 子代理：Task/Agent 工具（老版本 Task、新版本 Agent）；team mode / teammates：`send_message`、`TaskStop`、`TaskOutput`、`TaskCreate/Update/Get/List`、team 管理，worker 以子会话运行。
- 认证：Claude 订阅（Pro/Max 等）OAuth 登录或 API key。
- 缺口：print 模式是"跑完退出"的一次性进程；SDK 有权限/生命周期回调，但"外部进程 kill 运行中的 print 会话"没有公开的进程级协议，通常靠进程信号 + SDK 事件处理。

来源：
- https://code.claude.com/docs/en/headless（本环境无法直连，经官方文档快照/镜像核验：`-p/--print`、`--output-format`、`--resume`、`--no-session-persistence`）
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://github.com/anthropics/claude-code

### DeepSeek Harness（dsh）

- 官方开源 agent harness（DeepSeek AI），"一切皆插件"，基于 Cordis；**developer preview，兼容性会被破坏**。
- 入口：`npx @deepseek-ai/dsh web`（Web UI，默认 http://127.0.0.1:3080）；CLI `dsh --profile <name> ...`；headless 一次性任务 `dsh --profile headless "run the tests"` 通过核心注册表创建持久化 Agent；插件管理 `dsh plugin --profile <name> add <plugin>`。
- 生态动作：`dsh-bridges` 插件把已配置 Claude Code / CodeBuddy / OpenCode / Codex / Pi / Gemini CLI / Cursor 的项目桥接进 dsh（skills、commands、memory、hooks、permissions、MCP 按工具逐项支持）。
- 缺口：预览期、API 不稳定；官方尚未见"从外部控制面编排 dsh 实例"的稳定协议。

来源：
- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.zh.md
- https://github.com/yhlooo/dsh-bridges

### Pi（earendil-works/pi，原 badlogic/pi-mono）

- 定位：极简 agent harness，核心刻意不带 subagents、不带权限弹窗、不带计划模式。
- 四种模式：交互式 TUI；print/JSON（`pi -p "query"`、`--mode json` 事件流）；RPC（stdin/stdout JSONL）；SDK（Node.js 嵌入）。
- 认证：API key 或 `/login` OAuth 订阅；15+ 提供商。
- 子代理：核心不提供，社区包 `pi-mono-team-mode` 镜像 Claude Code team mode：`agent(...)` / `delegate(...)` / `send_message(...)` / `task_stop` / `task_output` 等；worker 默认以 `pi --session` 子进程运行（持久、可恢复、支持 worktree 隔离），另有 transient 进程内模式；完成以通知唤醒协调者，非轮询。
- 缺口：官方承认"向正在运行的 worker 注入消息"不被支持（每个 send_message 是恢复会话）；RPC 模式文档存在于 pi.dev/docs（Programmatic usage 分组）。

来源：
- https://pi.dev
- https://pi.dev/docs
- https://pi.dev/packages/pi-mono-team-mode
- https://github.com/earendil-works/pi

### 其他值得参考的 harness

- Gemini CLI：ACP 参考实现（Zed 首个合作方）。
- Goose（Square）：原生实现 ACP 的开源 agent。
- OpenCode：agent 框架/CLI，常作为"包装对象"出现在控制面项目里。

来源：https://zed.dev/blog/acp-progress-report

## 互操作协议定位

| 协议 | 层 | 覆盖 | 不覆盖 |
|---|---|---|---|
| MCP | agent → 工具/资源 | 工具、资源、提示词、采样、取消、进度 | agent 生命周期、进程控制 |
| A2A | agent ↔ agent | 任务消息、Agent Card 发现、协作 | 子代理协议、工具调用、进程生命周期（官方明示 "Not a sub-agent or tool-call protocol"） |
| ACP | client ↔ agent | 会话、消息流、权限、取消/关闭 | 进程 spawn/kill/wait、父子代理编排 |
| AGNTCY | 网络/目录层 | 目录服务、身份、SLIM 安全消息、可观测性 | harness 内部生命周期 |
| Agent Protocol（AI Engineer Foundation，又名 Arcadia） | agent 服务化 | REST/OpenAPI：创建任务、步骤列表、输出流、取 artifacts | 进程级控制、子代理树 |
| OpenAI Agents SDK / Claude Agent SDK | 框架层（进程内） | handoffs / subagents、workflow（agent/parallel/pipeline） | 跨 harness、跨进程编排 |

来源：
- https://modelcontextprotocol.io/specification/2025-06-18
- https://a2a-protocol.org/latest/
- https://docs.agntcy.org/
- https://agentclientprotocol.com/protocol/v2/overview

### 框架/SDK 层与 Agent Protocol

- **Agent Protocol（AI Engineer Foundation，又名 Arcadia）**：vendor-neutral 的 REST/OpenAPI 规范，把 agent 当服务暴露——创建任务、列步骤、流式输出、取 artifacts；最初在 Significant-Gravitas/AgentProtocol，后移交 AI-Engineer-Foundation。它接近"任务级调用"，但没有进程级 kill/wait 与子代理树语义。
- **OpenAI Agents SDK**：进程内 handoffs / subagents（嵌套 handoffs 为 opt-in beta），是框架而非跨 harness 控制面。
- **Claude Agent SDK**：`query()` + `AgentDefinition` 子代理（独立上下文窗口、按子代理限定工具），TS 0.3.149+ 有 workflow 工具（`agent()` / `parallel()` / `pipeline()` / `phase()`，支持 `resumeFromRunId`）。

来源：
- https://github.com/AI-Engineer-Foundation/agent-protocol
- https://openai.github.io/openai-agents-python/handoffs/
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/subagents

## 已有的"统一控制面"尝试

1. **Zed + ACP 生态**：ACP 是 editor↔agent 协议；Zed 开源的 codex-acp adapter 证明"把 Codex 包装成 ACP agent"可行；Neovim/Emacs/JetBrains 等作为 client。定位是编辑器替代 UI，不是"核心 agent 编排其他 agent"。
2. **Warp Oz**：商业云控制面，多 harness（Warp Agent、Claude Code、Codex），其中 **Warp Agent 可作父代理 spawn Claude Code/Codex 子代理**，统一治理/审计/内存；但它是云产品，父代理限定 Warp Agent。
3. **liteLLM Agent Platform（LAP）**：Rust 网关 + agent 控制面，目标"注册、调用、观测、治理多个运行时里的 agent"，pre-v0 实验项目。
4. **agent-control（xuzhougeng/agent-control）**：开源 "Coding Crew helm"：`cc-control`（REST+WS 控制面）+ `cc-agent`（自家 LLM 循环）+ `cc-proxy`（PTY 包装 Claude Code/Codex/Gemini CLI/OpenCode 为会话）+ 自定义 worker（NDJSON over stdio）；多租户、审批门、审计日志。
5. **dsh-bridges**：把其他 harness 的配置格式单向桥接进 DeepSeek Harness（不是双向控制面）。

来源：
- https://docs.warp.dev/platform/harnesses/warp-agent/
- https://www.warp.dev/blog/multi-harness-cloud-agent-orchestration
- https://docs.litellm.ai/blog/agents-are-the-new-llms
- https://github.com/xuzhougeng/agent-control
- https://github.com/yhlooo/dsh-bridges

## 对自研中间层的启示

- 统一工具面（spawn / send / followup / interrupt / wait / list）对应每个 harness 的"最接近的原生机制"各不相同：Codex 内部工具面、Claude Code Agent SDK/team mode、dsh headless 持久 Agent、pi RPC/team-mode 扩展。
- 一个可行的分层：控制面定义统一 agent 句柄 + 事件流；adapter 把操作翻译成各 harness 的入口（CLI 子进程 / SDK / RPC / ACP）；进程 spawn、kill、wait 由控制面统一管理，协议层（ACP/MCP/A2A）只承担各自擅长的会话、工具、消息部分。
- 已有项目里 Warp Oz 最接近"跨 harness 编排"，但闭环在云产品里；agent-control 是开源且形态最接近，但核心 agent 是自家 cc-agent + PTY 包装，不是"留在原生 harness 里通过工具面驱动"。
