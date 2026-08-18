# 命令-查询分离与生命周期事件归属

七动作按命令与查询分置：spawn / send / interrupt / kill 是命令，只返回回执（SessionId、SendAck、InterruptAck、KillResult），后果一律是领域事件；wait / list / subscribe 是查询。interrupt 返回 ack（requested / idle），其 cancelled 结果经事件流由调用方用 wait 组合获取——"返回回合结果"的动词语义保留在工具层，而不是核心原语。

生命周期事件（session.created、turn.started、session.killed）由 core 拥有并发出，driver 只发 worker 内容事件（text.delta、message(worker)、tool.*、permission.*、turn.completed）；turnId 由 core 分配并作为参数传给 driver。这样 WorkerDriver 方法不再承担"必须同步发事件"的口头时序义务，契约由类型和代码固化。worker 边界天然异步，任何把时序写进注释的契约都会在真实 adapter 上失效。
