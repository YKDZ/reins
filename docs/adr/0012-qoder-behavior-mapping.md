# qoder 行为映射：中断、清理与失败面

interrupt 用 `q.interrupt()` 发出控制请求，不依赖其 ack：adapter 标记当前 turnId 为 cancelling，等观察到 `assistant.aborted` 或 `session_state_changed(idle)` 再合成 `turn.completed(cancelled, finalReply=null)`；不设定时兜底，CLI 进程死亡由流结束 / 错误自然兜底为 failed。带 message 的 interrupt 不在 qoder 层用 `priority:'now'`（会在核心不知情时开启新回合、turnId 错位），而是先取消、落定后以 `shouldQuery:false + priority:'later'` 注入纯上下文消息；"打断并追问"由核心层 interrupt + send 组合表达。

kill 的 `terminate` 用 `abortController.abort()`（摧毁输入流、结束迭代、杀子进程），不用 `close()`（优雅拆除，语义不匹配）；spawn 时固定 `persistSession:false`，qoder 侧不落盘转录，reins 自己的调试 transcript 是唯一本地记录（呼应 ADR-0009 会话驻内存）。

`WorkerSpec.sandbox` 与 `reasoning` 在 qoder SDK 无对应面（effort 只在 pull-mode 模型策略里），v1 丢弃并在 transcript 标注"未映射"，不伪造映射；会话级失败（auth 过期、流错误、CLI 退出）统一映射为 `turn.completed(failed)`，细节进 transcript，协议错误码不动。adapter 先不往 `adapter-kit` 放共享代码，等第二个 adapter 证明 seam；adapter 的 `emit` 可能被核心在边界注入时同步重入 `deliver`，驱动必须可重入。
