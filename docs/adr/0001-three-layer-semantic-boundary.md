# 三层架构与语义边界

reins 采用三层结构：接口层定义动作语义（spawn / send / wait / interrupt / kill / list / attach 与事件流），UI 层把它包装成核心 agent 可调用的工具（当前形态为 CLI），适配层每个 harness 一个 adapter 把统一动作翻译为该 harness 的原生入口。

控制面只做动作语义的适配与转发，不做任务编排；认证、权限模式等 harness 特有面一律交给 harness 自己处理，不模仿 ACP 桥接所有逻辑上应该支持的功能。各家扩展能力良莠不齐，只保证语义化操作可用，既保住原生 harness 的提示词与机制，也避免 ACP 式全功能桥接的复杂度。
