# 错误语义分层：程序化错误码在核心，语义化呈现留在 UI 层

提供给 agent 的操作必须清晰抛错，且程序化与语义化并存，但两者分层：protocol 定义类型化错误码（如 session_not_found、session_killed、permission_pending、invalid_params），core 只返回结构化结果或按码抛出带上下文的 MachineError，不含面向 agent 的文案；CLI / MCP 负责把错误码映射为清晰可读、可操作的消息，机器可读输出同时携带 code 与 message。

文案与呈现规则随界面形态（CLI / MCP）变化，放进核心层会让 core 承担 UI 职责、污染领域层；错误码属于跨层契约，必须留在 protocol 供调用方编程判断。wait 对已 kill 的会话返回 per-id 状态而不是错误，只有不存在的 id 才抛 session_not_found。
