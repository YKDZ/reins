# 领域事件词汇与核心能力不降级

事件流只包含 10 类归一化领域事件：session.created、turn.started、text.delta、message、tool.started、tool.completed、permission.requested、permission.resolved、turn.completed、session.killed。adapter 的原生输出（ANSI / TUI 帧、harness 专有字段）不得进入事件流，只落 daemon 侧的调试 transcript；meta 仅允许 adapter 声明的白名单键，核心层不解读。wait 返回 turn.completed 中的 finalReply + stopReason + usage。

permission.requested 只在所属回合内有效：回合以 cancelled / failed / killed 结束时，未决请求自动作废，不补发合成的 permission.resolved；关闭请求的责任属于 worker / driver。

message 事件的 role 为 driver / worker：driver 侧表示核心 agent 的输入，由控制面在 send 触发新回合与边界注入时发出并复用 ack 的 messageId；worker 侧表示 worker 的输出，由 adapter 发出。

核心动作不允许降级：核心集为七个动作加流式 / 权限事件，每个核心 adapter 必须通过语义验收测试；实现手段不限（原生 SDK 优先，必要时允许 PTY 注入、信号等进程级手段），语义无法实现的 harness 不进 v1 核心集合。取消 degraded 标注，能力声明仅作诊断信息。
