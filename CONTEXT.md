# reins

reins 是一个本地控制面程序：让运行在原生 harness 里的核心 agent 以统一动作面驱动其他 harness 上的 agent，充当各 harness 之间的中间层。

## 术语

**控制面**:
reins 整体程序，位于核心 agent 与各 harness 之间；只做动作语义的适配与转发，不做任务编排。
_Code_: `controlPlane`
_Avoid_: 编排器, orchestrator, 网关

**harness**:
运行某个模型官方 agent 体验的程序，如 Codex、Claude Code、Qwen Qoder。控制面只通过 harness 公开的编程入口驱动它。
_Code_: `harness`
_Avoid_: 运行时, 宿主程序, shell

**核心 agent**:
发起调用的 agent，运行在原生 harness 里，以调用工具的方式使用 reins。
_Code_: `coreAgent`
_Avoid_: 主 agent, 父代理

**worker**:
被核心 agent 通过 reins 驱动的其他 harness 上的 agent。
_Code_: `worker`
_Avoid_: 子代理, subagent, 从 agent

**会话**:
spawn 创建、在 kill 之前一直常驻的 worker 上下文；busy 时 send 在下一个消息边界注入，idle 时 send 触发新回合。
_Code_: `session`
_Avoid_: 线程, thread, 任务

**回合**:
会话内的一次执行单元，由 spawn 的首条消息或 send 触发，wait 等待它完成并取得结果。
_Code_: `turn`
_Avoid_: 任务, 轮次

**消息**:
会话一侧的一条完整消息的落盘事件，与流式增量 text.delta 相对；role 为 driver 表示核心 agent 的输入、worker 表示 worker 的输出。driver 侧消息由控制面自身发出。
_Code_: `message`
_Avoid_: 回复, 输出

**动作**:
接口层暴露的动词操作：spawn、send、wait、interrupt、kill、list、attach。
_Code_: `action`
_Avoid_: 操作, 命令

**事件**:
接口层发出的归一化会话事实，如 text.delta、tool.completed、turn.completed；adapter 的原生输出不得进入事件流。
_Code_: `event`
_Avoid_: 消息流, 日志

**终态**:
回合结束的原因（end_turn、cancelled、failed、killed），事件字段名为 stopReason。
_Code_: `stopReason`
_Avoid_: 结束状态, exit code

**中断**:
interrupt 动作：停止进行中的回合，保留会话与上下文，可附模型可见说明。
_Code_: `interrupt`
_Avoid_: 停止, cancel

**清理**:
kill 动作：彻底终止会话与底层进程树，不可恢复。
_Code_: `kill`
_Avoid_: 删除, 关闭, close

**接口层**:
定义控制面动作语义的层；spawn、send、wait、interrupt、kill、list、attach 与事件流都定义在这里，是所有 harness 看到的统一面。
_Code_: `core`
_Avoid_: 核心层, API 层

**UI 层**:
把接口层能力包装成核心 agent 可调用工具的层；当前形态为 CLI。
_Code_: `ui`
_Avoid_: 前端, 客户端

**适配层**:
接口层与具体 harness 之间的桥接层；每个 harness 一个 adapter，把统一动作翻译为该 harness 的原生入口。
_Code_: `adapters`
_Avoid_: 插件层, driver 层

**adapter**:
适配层中对应单个 harness 的翻译器。
_Code_: `adapter`
_Avoid_: 驱动, connector, 桥
