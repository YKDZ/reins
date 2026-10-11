# 原生工作树准备

`reins workspace harnesses|attach|status|detach` 以当前目录或 `-C` 选定已经存在的 Git worktree。调用方 launcher 继续显式提供 `REINS_CONSUMER_CONTEXT`；这不是 CLI 动作参数，也不会进入结果。附着不会创建 worker 或回合。

项目在 worktree 根目录的 `.reins/workspace.json` 显式绑定部署材料：

```json
{
  "environments": [
    {
      "provider": "docker",
      "image": "registry.example/project@sha256:<64 hex digits>"
    }
  ],
  "runtimes": [
    {
      "harness": "codex",
      "version": "0.149.0",
      "image": "registry.example/codex-material@sha256:<64 hex digits>"
    }
  ],
  "bindings": [{ "ref": "code", "harness": "codex" }]
}
```

这里的摘要必须替换为实际固定摘要；本机已有镜像也可以使用完整 `sha256:` image ID。环境恰好一个，每个可选 harness 恰好一个运行定义；缺失、多义或未固定的定义会被拒绝。目录返回环境及运行定义的 SHA-256 指纹、绑定展开和凭据省略事实，不探测厂商在线资源，也不选择默认项。当前支持包接缝为 Codex（`codex`）和 QoderCN（`qoder`）的 Docker 原生镜像材料。

部署的环境镜像提供 Linux x64、Node 24、Git，以及当前 Reins 发行包的 `/opt/reins/dist/reins-daemon.js` 和运行依赖。支持包的材料镜像分别在 `/opt/reins/harnesses/codex`、`/opt/reins/harnesses/qoder` 提供完整本地运行材料，入口是对应目录下 `bin/codex`、`bin/qoderclicn`。provider 从精确镜像提取选定材料，验证本地版本入口，再完成真实 daemon 的版本与消费者握手。这里没有安装命令配置、shell recipe、tag 回退或厂商模型调用。具体厂商组合仍须独立真实验收；测试材料镜像只能证明其实际经过的准备链。

```sh
reins workspace harnesses -C /absolute/worktree/src
reins workspace attach -C /absolute/worktree/src --binding code
reins workspace status -C /absolute/worktree/src
reins workspace detach -C /absolute/worktree --session-disposition require_none
```

Manager 将原生 worktree、专属 Git metadata 和公共 Git metadata 直接绑定到相同绝对路径，并核对底层 device/inode。它为附着创建独占可写 home 和 daemon state；没有宿主 home 挂载或扫描。省略凭据保持省略，不猜测凭据来源。Manager／shared client 的附着受理返回 `preparing`，不把完整 Docker 准备绑在短连接请求上；调用方通过 `status` 观察 `ready` 或具体失败。CLI `attach` 等待同一次准备终态，失败时输出完整准备事实并非零退出；合法准备中不会成为失败，只读状态请求超时会重新查询。逐 harness 阶段、源码身份验证、runtime 状态和历史不可用事实分别投影；`preparation.attempts` 保留每次准备的状态及原错误；本地历史由后继票接入。

Codex 0.162.0 的 Docker 支持包提供单文件 ChatGPT 登录绑定。部署者在 Manager launcher 显式提供 `REINS_CODEX_AUTH_BINDINGS`，其值是凭据引用到绝对 `auth.json` 路径的 JSON 映射，例如 `{"selected-login":"/private/selected-auth.json"}`；项目绑定只写 `{"ref":"code","harness":"codex","credentialBindingRef":"selected-login"}`。路径和 secret 均不经过工作区动作协议；目录发现只返回非秘密引用及支持事实，不读取源文件或启动模型。

准备时扩展只读取选定文件，验证该版 ChatGPT 登录结构，将 `auth_mode`、`tokens` 与可选 `last_refresh` 写入私有 `$CODEX_HOME/auth.json`（目录 `0700`、文件 `0600`）。其余配置键、宿主配置、历史、skills 和指令不会被投影，源文件不会回写。没有该引用、文件不可读、登录结构无效或该固定组合不支持时返回 `credential_binding_unavailable`，不会换认证方式；材料版本不符则返回 `runtime_entry_invalid`。`ready` 证明材料和绑定已交付以及本地 daemon 可连，不证明 token 在远端仍有效。此扩展的首回合支持范围不包含共享刷新、凭据轮换、过期恢复或并发保证；这些必须另行实测。QoderCN 使用自己的原生登录文件。

固定 QoderCN SDK 1.0.23／worker 1.1.23 的材料目录还须包含完整的 `worker/` 闭包（实际入口 `worker/qoder-worker-runtime.obf.mjs`）；`bin/qoderclicn` 可以直接调用同一 worker 的 CLI 模式。provider 分别执行 CLI 与 worker 的真实版本入口。Manager 将固定 worker 路径通过 SDK 的公开 `pathToQoderCLIExecutable` 选项交付，SDK 按入口选择 WorkerTransport，不回退宿主全局 CLI。

QoderCN Manager launcher 显式提供 `REINS_QODER_AUTH_BINDINGS`，例如 `{"selected-login":{"userFile":"/private/selected-user","machineIdFile":"/private/selected-machine-id"}}`。固定支持包只读取选定的两个非空原生文件，将原始字节写入私有 `HOME/.qoder-cn/.auth/user` 与 `machine_id`（0600），不解密或重造厂商格式，不复制 settings、cache、历史、锁文件或完整 home。`qodercliAuth()` 由原生 SDK 只读消费，源文件不回写；省略绑定不搜索宿主。缺失来源或空文件是 `credential_binding_unavailable`，材料版本或 worker 入口错误是 `runtime_entry_invalid`；非空但无效的原生登录由真实 worker 判定，不把 ready 当作远端认证成功。不承诺凭据刷新、并发轮换或重启恢复。

附着受理与所有者写入 Manager 的持久状态，关闭 CLI 连接不会释放它。相同所有者及绑定集合复用已经准备的附着；不同所有者或不同意图被拒绝。每个 harness 最多选定一个绑定。逐绑定独立准备，一项失败仍继续其他项；全局 runtime 保留失败事实，ready 绑定仍可创建独立会话并发运行。`detach require_none` 只释放没有会话的环境，保留源码与准备事实。

准备中重复相同绑定集合会观察当前尝试，不另起执行。失败后，调用方修正条件并显式重复相同请求才会受理新尝试；继续未完成的阶段，保留已完成的材料和私有 home。已接受的环境、运行材料及绑定快照不会因当前目录配置变化而被替换；不同显式绑定集合返回 `attachment_intent_conflict`。同引用换 harness、凭据引用、省略状态或 launcher 原生来源路径同样被拒绝；来源路径只以私有不可逆意图摘要持久化。允许同一路径的内容修正，相同非空、顺序无关的绑定组合只续行失败阶段；成功绑定不重新安装或复制凭据。材料缺失与实际摘要核验失败分别持久表达为 `material_unavailable`、`material_digest_mismatch`。

Manager 在原生视图验证后、绑定安装前建立并保持真实 daemon 控制连接，防止慢安装或部分绑定失败时空闲退出丢失已有环境；不创建会话。Manager 重启将失去执行者的准备尝试记为 `preparation_interrupted`，不会自动重试。续行先核对已保存的容器身份和真实运行状态，并实际执行已成功绑定的版本入口；ready 重入同样核验实际入口，失效时明确失败而不重装。创建或安装步骤的效果仍无法确定时返回 `preparation_outcome_unknown`，不通过重新创建覆盖未知结果。调用方的源码和有价值状态不因准备失败被清理。

Manager 正常停止时先关闭新请求受理，等待已受理请求和准备执行完成持久发布，随后关闭 daemon 连接并释放状态 lease，避免旧执行与新 Manager 同时写入。

正式发行包包含 sibling `reins-workspace-manager`。默认状态位于 `$XDG_STATE_HOME/reins/workspace-manager`（未设置时为 `$HOME/.local/state/reins/workspace-manager`）。部署与测试可显式设置 `REINS_WORKSPACE_MANAGER_BIN`、`REINS_WORKSPACE_MANAGER_SOCKET` 和 `REINS_WORKSPACE_MANAGER_STATE_DIR`。开发 launcher 为当前 checkout/build 隔离这些路径。Docker 连接与公开镜像拉取使用 launcher 的现有 Docker 配置，产品不改用户配置。
