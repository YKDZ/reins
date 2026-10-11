# 原生工作树准备

`reins workspace harnesses|attach|status|history|detach` 以当前目录或 `-C` 选定已经存在的 Git worktree。调用方 launcher 继续显式提供 `REINS_CONSUMER_CONTEXT`；这不是 CLI 动作参数，也不会进入结果。附着不会创建 worker 或回合。

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

Manager 将原生 worktree、专属 Git metadata 和公共 Git metadata 直接绑定到相同绝对路径，并核对底层 device/inode。它为附着创建独占可写 home 和 daemon state；没有宿主 home 挂载或扫描。省略凭据保持省略，不猜测凭据来源。Manager／shared client 的附着受理返回 `preparing`，不把完整 Docker 准备绑在短连接请求上；调用方通过 `status` 观察 `ready` 或具体失败。CLI `attach` 等待同一次准备终态，失败时输出完整准备事实并非零退出；合法准备中不会成为失败，只读状态请求超时会重新查询。逐 harness 阶段、源码身份验证、runtime 状态和本地历史健康分别投影；`preparation.attempts` 保留每次准备的状态及原错误。

Codex 0.162.0 的 Docker 支持包提供单文件 ChatGPT 登录绑定。部署者在 Manager launcher 显式提供 `REINS_CODEX_AUTH_BINDINGS`，其值是凭据引用到绝对 `auth.json` 路径的 JSON 映射，例如 `{"selected-login":"/private/selected-auth.json"}`；项目绑定只写 `{"ref":"code","harness":"codex","credentialBindingRef":"selected-login"}`。路径和 secret 均不经过工作区动作协议；目录发现只返回非秘密引用及支持事实，不读取源文件或启动模型。

准备时扩展只读取选定文件，验证该版 ChatGPT 登录结构，将 `auth_mode`、`tokens` 与可选 `last_refresh` 写入私有 `$CODEX_HOME/auth.json`（目录 `0700`、文件 `0600`）。其余配置键、宿主配置、历史、skills 和指令不会被投影，源文件不会回写。没有该引用、文件不可读、登录结构无效或该固定组合不支持时返回 `credential_binding_unavailable`，不会换认证方式；材料版本不符则返回 `runtime_entry_invalid`。`ready` 证明材料和绑定已交付以及本地 daemon 可连，不证明 token 在远端仍有效。此扩展的首回合支持范围不包含共享刷新、凭据轮换、过期恢复或并发保证；这些必须另行实测。QoderCN 使用自己的原生登录文件。

固定 QoderCN SDK 1.0.23／worker 1.1.23 的材料目录还须包含完整的 `worker/` 闭包（实际入口 `worker/qoder-worker-runtime.obf.mjs`）；`bin/qoderclicn` 可以直接调用同一 worker 的 CLI 模式。provider 分别执行 CLI 与 worker 的真实版本入口。Manager 将固定 worker 路径通过 SDK 的公开 `pathToQoderCLIExecutable` 选项交付，SDK 按入口选择 WorkerTransport，不回退宿主全局 CLI。

QoderCN Manager launcher 显式提供 `REINS_QODER_AUTH_BINDINGS`，例如 `{"selected-login":{"userFile":"/private/selected-user","machineIdFile":"/private/selected-machine-id"}}`。固定支持包只读取选定的两个非空原生文件，将原始字节写入私有 `HOME/.qoder-cn/.auth/user` 与 `machine_id`（0600），不解密或重造厂商格式，不复制 settings、cache、历史、锁文件或完整 home。`qodercliAuth()` 由原生 SDK 只读消费，源文件不回写；省略绑定不搜索宿主。缺失来源或空文件是 `credential_binding_unavailable`，材料版本或 worker 入口错误是 `runtime_entry_invalid`；非空但无效的原生登录由真实 worker 判定，不把 ready 当作远端认证成功。

该固定组合已实测同一绑定的两个任务并行，以及 daemon／容器重启后的显式新任务；旧会话身份不恢复，任务不自动重放。全会话 kill 先由原生入口取消执行，再关闭 SDK，已实测活动 Bash 工具进程组停止。精确 `active_turn` 与 `interrupt` 仍在原生效果前返回 `unsupported_feature`。个人凭据到期、刷新和轮换未验证，不承诺共享刷新或普遍并发保证；真实厂商验收独立留证，不作为 CI 在线门禁。

附着受理与所有者写入 Manager 的持久状态，关闭 CLI 连接不会释放它。相同所有者及绑定集合复用已经准备的附着；不同所有者或不同意图被拒绝。每个 harness 最多选定一个绑定。逐绑定独立准备，一项失败仍继续其他项；全局 runtime 保留失败事实，ready 绑定仍可创建独立会话并发运行。

脱离必须显式选择 `--session-disposition require_none` 或 `kill`。`require_none` 原子检查真实存活会话并关闭新的修改准入，已终止但仍可列出的会话不阻止脱离；前置检查失败不会接受意图。`kill` 接受后同样拒绝新的 spawn、send 和授权修改，再实际终止 worker、销毁环境并逐步释放凭据、绑定、路由与归属。正式工作区路由保留原 CommandId、ACK、未知结果及订阅语义；部署内的原生 socket 与显式 `REINS_SOCKET` 入口继续按原生传输工作。

已接受的意图与每步释放事实持久化。中断或再次失败后，相同意图只续未完成步骤，不自动重建环境；调用方可显式将 `require_none` 升级为 `kill`，反向变更被拒绝。公开 `status` 继续返回原生源码身份、清理进度及已观察到的 session/turn 关联。`detachment.sessions[].outcome` 的 `confirmed` 表示原生终止已确认；`terminated_by_workspace_detach` 只在 provider 已证明环境消失时结算未确认 worker；证据不足保持 `unknown` 和失败进度。后者不会补造 harness 的 `turn.completed`，已有唯一回合终态保持原样。

脱离保留原生工作树、已有本地事实与价值状态，释放私有凭据投影及运行资源；不承诺保留整个 harness 临时 home。工作区清理投影不代替实际收到的类型化事件日志，产品资源释放与测试平台回收分别记录。

准备中重复相同绑定集合会观察当前尝试，不另起执行。失败后，调用方修正条件并显式重复相同请求才会受理新尝试；继续未完成的阶段，保留已完成的材料和私有 home。已接受的环境、运行材料及绑定快照不会因当前目录配置变化而被替换；不同显式绑定集合返回 `attachment_intent_conflict`。同引用换 harness、凭据引用、省略状态或 launcher 原生来源路径同样被拒绝；来源路径只以私有不可逆意图摘要持久化。允许同一路径的内容修正，相同非空、顺序无关的绑定组合只续行失败阶段；成功绑定不重新安装或复制凭据。材料缺失与实际摘要核验失败分别持久表达为 `material_unavailable`、`material_digest_mismatch`。

Manager 在原生视图验证后、绑定安装前建立并保持真实 daemon 控制连接，防止慢安装或部分绑定失败时空闲退出丢失已有环境；不创建会话。Manager 重启将失去执行者的准备尝试记为 `preparation_interrupted`，不会自动重试。续行先核对已保存的容器身份和真实运行状态，并实际执行已成功绑定的版本入口；ready 重入同样核验实际入口，失效时明确失败而不重装。创建或安装步骤的效果仍无法确定时返回 `preparation_outcome_unknown`，不通过重新创建覆盖未知结果。调用方的源码和有价值状态不因准备失败被清理。

Manager 正常停止时先关闭新请求受理，等待已受理请求和准备执行完成持久发布，随后关闭 daemon 连接并释放状态 lease，避免旧执行与新 Manager 同时写入。

daemon 与容器重启是不同的部署动作。重新进入工作区时，Manager 实际核对原容器身份、原生工作树及 Git 元数据、执行目录、已选择绑定的本地 runtime 入口与 daemon 控制连接；已取得的共享客户端也不能凭旧准备事实放行新 worker。入口失效时先明确失败，调用方修正后显式重复原 `attach` 才继续验证，成功材料保持原样。正常重启后的旧会话及回合引用失效；原 worker 的停止事实与无法取得的旧业务结果分别表达。调用方用完整新消息和新名称显式 `spawn` 替代会话，复用代码与环境，不继承旧模型上下文，也不自动重放旧任务。厂商凭据刷新及具体原生控制的支持范围仍按各自真实组合验收。

正式发行包包含 sibling `reins-workspace-manager`。默认状态位于 `$XDG_STATE_HOME/reins/workspace-manager`（未设置时为 `$HOME/.local/state/reins/workspace-manager`）。部署与测试可显式设置 `REINS_WORKSPACE_MANAGER_BIN`、`REINS_WORKSPACE_MANAGER_SOCKET` 和 `REINS_WORKSPACE_MANAGER_STATE_DIR`。开发 launcher 为当前 checkout/build 隔离这些路径。Docker 连接与公开镜像拉取使用 launcher 的现有 Docker 配置，产品不改用户配置。

工作区部署还需提供同一发行包的 `/opt/reins/dist/reins-publisher.js`。runtime 的 `PATH` 绑定专用 `reins` 入口，只注册发布能力；帮助、错误候选和 publisher socket 的受理来自同一部署能力集合。该入口不能启动 Manager 或创建环境，不通过容器探测或角色选项切换职责。worker 自行选择普通文件或整理好的成果包后执行：

```sh
reins publish -- selected-file.tar
reins publish -- --option-like-name.txt
```

发布入口读取选定文件，将完整字节交给 Manager；Manager 在 runtime 之外的持久目录提交固定副本后返回 `ready`、独立发布标识、源工作目录、源路径、大小和摘要。后续修改或删除原路径不改副本，同路径的多次发布可以分别选择。没有自动扫描、发布提示词、成果齐全或任务完成判断。

消费者查询当前工作目录来源的发布，再显式接收到自己指定的活动树外接收区：

```sh
reins workspace publications -C /absolute/worktree
reins workspace receive pub-<uuid> --directory /absolute/receipts --active-root /absolute/worktree
reins workspace receipts --directory /absolute/receipts
```

共享客户端提供相同的 `publication.list` 查询、`receivePublication` 和 `receipts`。接收提交本地可用文件后才返回 `arrived`、来源、大小及实际 `localPath`；失败返回 `receipt_failed`，保留已成功发布的副本。发布和接收查询均限 launcher 绑定的消费者，跨消费者发布标识按不存在处理。本链可直接用于原生工作树附着，无需源码交接。回合完成、回复中的路径和发布成功都不会自动接收文件。

`reins workspace history -C /absolute/worktree` 显式查询当前消费者在该真实工作树各次附着中实际收到的类型化历史；`--all-worktrees` 聚合当前消费者的工作树。它与当前代的会话列表、有界 `attach` 回放窗口分别存在。记录回显当时的环境与 harness 运行指纹，不暴露内部沿袭或附着代际标识。同一真实工作树脱离再附着可以查到前代；删除后在同一路径新建的工作树具有新的沿袭。

历史日志在 Manager 状态目录中，位于可销毁环境之外，按收到的原始类型化事件追加并同步；同一 daemon 世代及会话内，重复订阅收到的同一事件只保存一次。查询的 `integrity: unknown` 明确表示这些记录不能证明尚未收到的事件或断连期间的事实齐全。历史健康单独投影写入、读取故障及未保存状态；故障不会改变已有回合终态，也不会为缺失记录编造事件。

脱离始终保留历史。管理员需要删除历史时，先停止使用同一状态目录的 Manager，再通过发行的独立管理入口执行：

```sh
REINS_WORKSPACE_MANAGER_STATE_DIR=/absolute/manager-state \
  reins-workspace-manager history-delete \
  --consumer-context explicit-owner --cwd /absolute/worktree
```

管理命令使用同一状态目录的独占 lease，只删除明确消费者与真实工作树沿袭的历史，不删除源码、已发布副本或附着事实。它不进入普通消费者 CLI 候选。没有第二台真实管理器的复制协议、隐含保留期限或自动历史回收。

工作区控制的既有 `wait` 返回原有 `status`、`completed`、`pending`，并附当前消费者／工作区的 `publications` 查询快照。发布不会使仍活动的回合满足等待条件，也不会把文件放入接收区。

既有 `attach`／共享 client 的 `subscribe` 在同一 Manager 连接上接收 `publication.ready`。成果事实只在固定副本提交后产生，包含完整发布记录；它属于工作区，既不声称属于某个回合，也不借用 daemon 的 Session EventId 或恢复游标。建立观察时提供当前可取回成果，之后只在该观察存续期间发送新增事实；daemon 的 `none`／`available`／`after` 仍只控制原生会话事件的有界回放。任务终态和文件到达继续分别报告。

关闭、结束或断开观察会移除对应的成果观察；没有等待或订阅时不承诺后台唤起。断连及通知丢失后，`workspace publications` 仍可查询固定副本，显式 `workspace receive` 才产生本地 `arrived` 事实。任务失败不删除发布，成果通知不证明任务完成或成果齐全。

成果查询失败时，已确定的 `wait` 结果与订阅结束事实仍返回，并以独立的 `publicationError` 报告发现失败；不把失败投影为空成果，也不改写任务终态。

已发布副本跨环境脱离保留；脱离后仍以原工作目录查询并显式接收。发布记录的 `storagePath` 是 Manager 上的实际固定副本位置；接收记录的 `localPath` 是消费者可使用的文件，`receiptId` 用于明确选择该次接收。同一发布可接收多次，接收不会删除发布。

```sh
reins workspace remove-publication pub-<uuid>
reins workspace remove-receipt receipt-<uuid> --directory /absolute/receipts
```

共享客户端分别使用 `request("publication.remove", { publicationId })` 与 `removeReceipt(directory, receiptId)`。每次只清理明确选中的当前消费者副本；另一端、未选副本、原生 Git 引用／对象、活动工作树和本地历史均独立保留。结果报告 `released` 或 `failed`，并列出目录、元数据和 payload 的实际 `present`／`absent`／`unknown` 状态；失败不冒充已经释放，CLI 非零退出。调用方修正原因后可再次明确清理同一副本；重复清理已经消失的副本返回实际为空的释放结果。产品副本清理不包含平台回收或 Git GC。
