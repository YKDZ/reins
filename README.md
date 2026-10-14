# Reins

Reins 是 Harness 控制面，通过统一的控制语义管理会话与回合，并提供能力
查询、观察和诊断。内置 Codex 与 QoderCN 适配器。

运行包 `@ykdz/reins` 提供 `reins` CLI、`reins-daemon` 和内置适配器；运行 `reins --help` 查看 CLI 命令。

轻量 SDK `@ykdz/reins-sdk` 导出 `connect`，供上层应用连接 Reins 控制面。
