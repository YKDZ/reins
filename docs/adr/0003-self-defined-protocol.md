# 内部协议自研，ACP 仅作 adapter

接口层与 UI / 适配层之间使用自研的最小动作协议（七个动作 + 归一化事件），传输为 stdio / Unix socket 上的 JSON-RPC 或 NDJSON。

不采纳 ACP 作为内部协议：ACP v1 稳定版与 v2 Draft 都没有 spawn / 子代理 / 进程级 kill / 阻塞 wait，v2 还移除了客户端文件与终端执行面；采纳它补不了进程语义，反而要承担会话 / 能力 / 认证面的超集负担。ACP 不作为内部协议；若某天需要接入 ACP-native harness（如 Qoder、Gemini CLI、Goose），可在适配层另行实现 ACP 适配器，当前版本不实现。
