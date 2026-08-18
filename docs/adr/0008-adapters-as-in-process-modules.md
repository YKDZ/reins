# adapter 以进程内模块形态接入

三个 harness adapter 都是本仓 TypeScript 模块，在 reins 进程内实现 WorkerDriverFactory，各自 spawn 外部 harness 进程或使用其进程内 SDK，不与 daemon 另设进程协议。WorkerDriver 已经是真实 seam（三个 adapter 共用同一契约），进程隔离目前没有变化点，新增一条 daemon↔adapter 进程协议只会平白扩大协议面；若未来出现隔离需求（崩溃、权限、语言异构），再把 adapter 拆成子进程并复用同一契约。
