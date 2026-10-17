# 发布 Reins

运行包 `@ykdz/reins` 和 SDK `@ykdz/reins-sdk` 共同使用 `apps/cli/package.json` 的版本。当前候选为 `0.2.0`，变更见 [CHANGELOG.md](CHANGELOG.md)。CLI 机器输出已切换到 v2。

## 审核候选

执行 `pnpm check:full`，完成轻、重验收。正式安装验收会在工作区外消费同组双包，生成 `.artifacts/release/` 中的两个 tgz、`SHA256SUMS`、`SHA512SUMS` 和 `verified-publication-artifact.json`。回执记录源码、版本、摘要及验收来源。

版本与变更说明经 PR 审核进入默认分支后，等待该提交的 `Root Check` 成功。GitHub 的 `Check` 工作流保留 `release-package` 原候选 30 天；首发和正常发布必须保留并使用同组原始文件。PR 的合并预览候选用于审核，首发使用实际默认分支提交产生的候选。

## SDK 首次公开

下载默认分支成功 Check 的 `release-package` 到干净、同提交的工作区，指定其绝对路径：

```sh
PUBLICATION_ARTIFACT_DIRECTORY=/absolute/path/to/release-package pnpm publication:setup
```

默认只展示和核验材料，没有公开写入。维护者确认发布后，在交互终端运行同一命令并追加 `--execute`。向导分三阶段完成 npm 自身的网页登录、发布原始 SDK tgz、配置双包 trusted publisher。凭据由 npm 直接处理，退出时登出并删除本次隔离会话，公开包缓存保留。

授权必须指向 `YKDZ/reins` 的 `release.yml`，仅允许直接发布，不配置 Environment 或暂存发布权限。若运行包仍有旧的暂存授权，向导会停止并给出包设置地址；维护者审核调整后用原候选重试。向导不会删除授权或创建 Release。人工首发没有 GitHub OIDC 来源证明，这一限定例外仅适用于 SDK 第一个真实版本。

## 正常发布与失败恢复

维护者从默认分支手动触发 `Publish verified Reins packages`。这一步会实际公开 npm 包，没有暂存后二次批准。工作流复用同提交成功 Check 的原候选，重新运行统一完整验收，依次执行 SDK、运行包、不可变 GitHub Release。只有尚未公开 SDK 且没有原候选时，才允许正式验收产生新候选。

发布步骤通过 OIDC 使用原始 tgz，核实公开注册表的字节、签名和适用来源证明。首次正常发布可核实人工首发 SDK 后只发布运行包；普通新运行不能任意接纳已有版本。

中途失败时保留原制品，在同一次工作流使用 **Re-run failed jobs**。已公开包须与原候选及发布运行完全一致，Release 只能补齐缺失附件，不能覆盖已有附件。只有双包核验成功才创建 Release，附件包括整个候选组。版本、字节、源码或来源冲突均停止，不重打包、不移动 tag、不删除公开包。原候选过期或丢失时，恢复原文件或准备新版本。

本轮仅准备发布路径并验证候选。没有执行 SDK 首发、OIDC 公开发布、发布 tag 或 GitHub Release；trusted publisher 的实际账号配置仍由维护者在发布时完成。
