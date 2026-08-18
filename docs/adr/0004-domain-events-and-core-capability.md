# 领域事件词汇与核心能力不降级

事件流只包含 10 类归一化领域事件：session.created、turn.started、text.delta、message、tool.started、tool.completed、permission.requested、permission.resolved、turn.completed、session.killed。adapter 的原生输出（ANSI / TUI 帧、harness 专有字段）不得进入事件流，只落 daemon 侧的调试 transcript；meta 仅允许 adapter 声明的白名单键，核心层不解读。wait 返回 turn.completed 中的 finalReply + stopReason + usage。

核心动作不允许降级：核心集为七个动作加流式 / 权限事件，每个核心 adapter 必须通过语义验收测试；实现手段不限（原生 SDK 优先，必要时允许 PTY 注入、信号等进程级手段），语义无法实现的 harness 不进 v1 核心集合。取消 degraded 标注，能力声明仅作诊断信息。
