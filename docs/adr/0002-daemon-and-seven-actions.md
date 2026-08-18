# 常驻 daemon 与七个动作

reins 采用常驻 daemon：会话表与 worker 进程表驻留内存，CLI 是它的薄客户端。spawn 之后的 send / wait / kill 是跨工具调用的分离语义，attach 需要事件转发，每次工具调用独立进程无法承载，因此进程形态必须常驻。

接口层提供七个动作：spawn、send、wait、interrupt、kill、list、attach，外加组合式便捷命令 run。send 只有一种语义（busy 时在下一个消息边界注入，idle 时触发新回合）；"排队到回合结束后发送"用 wait→send 组合，"打断并立即发送"用 interrupt→send 组合，均不设独立动词。interrupt 与 kill 保持双动词：前者可恢复、只作用于进行中的回合，后者不可逆地销毁会话与进程；后果不对称，不适合折叠进一个 mode 参数（依据见 docs/research/control-plane-gaps.md 的动词粒度调研）。
