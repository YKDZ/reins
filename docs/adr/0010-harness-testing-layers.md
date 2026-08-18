# harness 集成测试三层：单测 / 录制转写 / live smoke

核心语义用 fake driver 单测；adapter 的事件解析用"录制的真实 harness 输出 fixture"做单测，CI 无需 harness 二进制与登录态即可运行；完整语义验收用 env-gated 的 live smoke——检测到 harness 二进制与登录态时才跑真实 spawn→wait→kill。核心能力不降级的最终判定以 live smoke 为准，fixture 负责防回归。
