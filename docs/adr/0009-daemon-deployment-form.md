# daemon 部署形态

daemon 是单用户本机常驻进程：持有一个 SessionMachine、adapter 表与 worker 进程表；CLI 经 Unix socket 上的 NDJSON 行协议与之通信，首次 CLI 调用自动拉起、空闲超时退出，并保留前台运行模式供调试。会话驻内存、进程树级联清理；每会话自带 cwd，因此全局单例可服务多个项目；凭据留在各 harness 自己的登录态，daemon 不触碰。七动作跨工具调用需要状态驻留，而单例加会话级 cwd 是满足这一点的最小部署形态。
