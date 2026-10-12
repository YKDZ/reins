# 源码材料内部实现

`@reins/workspace-source` 是 Reins 的私有实现包。固定提交的产品入口由 Tack application 与 `tack environment prepare --commit` 承担；Reins CLI 不再提供仅固定提交交接。剩余的显式文件选择迁移完成前，Manager 仍使用这里的材料实现。

Manager 将收到的固定提交和选定文件材料物化为普通 Git worktree，再沿现有 runtime attach 路径准备目标环境；runtime 只接收目标主机上的原生 cwd。源码包及 Manager 的 handoff 请求不是公开 SDK。

仅这条缺少原生路径上下文的显式跨域链返回 WorkspaceHandle。句柄只能由同一消费者通过 `workspace.locate` 或 `manager.control({ workspaceHandle })` 使用；它寻址工作区，不是源码快照生命周期。已有原生 cwd 链不产生句柄。

每次交接创建新传入树，保留原 HEAD、index、文件及会话 cwd。固定输入不包含调用侧未提交文件；需要时使用下述显式文件选择。脱离 runtime 不删除输入源码，调用方可在会话结束后通过目标主机的原生 Git／文件动作清理工作树及对应对象库。

当前接受 SHA-1 固定提交和完整、非 thin Git pack。pack、单文件和目录清单的处理上限各为 32 MiB；超限、缺失对象、损坏材料、gitlink、无法精确保留的 checkout 属性及逃逸的目标子目录整体以 `source_invalid` 拒绝。支持普通文件、可执行位和符号链接，物化后逐项核对原始对象字节与属性。Git 环境忽略全局／系统配置和替换对象，不为调用方执行自定义过滤器或 hook。

## 选择未提交文件

`captureSelectedWorkingFiles(repositoryPath, commit, selection)` 在固定提交之上添加调用方逐项选择的版本，例如：

```ts
const material = await captureSelectedWorkingFiles(repositoryPath, commit, [
  { path: "src/staged.ts", source: "index" },
  { path: "src/working.ts", source: "worktree" },
  { path: "notes/extra.txt", source: "worktree" },
]);
```

路径必须从同一 Git 根开始，明确选择一个文件，不能选择目录或重复路径。`index` 读取该路径的暂存版本，`worktree` 读取当前工作文件字节；未跟踪、忽略文件也只按清单纳入。选中已删除的受跟踪路径会在目标删除该路径。目标 index 保持固定提交状态，不重建原暂存分层；调用侧不写入 HEAD、index、文件或新提交。相同清单的后续交接仍创建新树。

Reins 的 `workspace handoff` 仅接受显式 `--index-file <paths...>` 或 `--worktree-file <paths...>` 选择；未选择文件时返回 `source_invalid`，不请求 Manager 创建工作区。固定提交交接应使用 Tack 的 application 或 CLI 入口。

选定文件支持原始二进制字节、普通 `0644`／可执行 `0755` 文件及 UTF-8 符号链接；其他权限、硬链接、特殊文件、符号链接父目录和不支持的 Git index 条目整体拒绝。清单最多 1024 项，固定 pack 与选定文件字节总和最多 32 MiB。捕获重复读取选定字节并核对文件身份、元数据及 HEAD/index；检测到变化即整体拒绝。进行中的合并、rebase、cherry-pick、revert、bisect、sequencer、index 锁及 unmerged index 同样整体拒绝。目标先校验完整固定提交及所有选定材料，再覆盖并核对字节与必要属性，失败删除整棵新输入树。

本轮实际支持与验证普通 SHA-1 仓库、普通目标 Git worktree；不声明稀疏检出、子模块、Git LFS、特殊文件系统属性或其他特殊 Git 形态的支持。
