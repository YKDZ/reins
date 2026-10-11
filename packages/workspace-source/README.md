# 固定提交源码桥接

`@reins/workspace-source` 负责调用侧捕获与目标侧普通 Git worktree 物化。Manager 组合桥接与现有 `runtime.attach`，runtime 仍只接收目标主机的原生 cwd。

消费者调用 `captureFixedCommit(repositoryPath, commit)` 捕获一个 Git root 的完整固定提交，再通过共享客户端请求 `workspace.handoff`：

```ts
const material = await captureFixedCommit(repositoryPath, commit);
const incoming = await manager.request("workspace.handoff", {
  material,
  subdirectory: "src",
  bindings: ["code"],
});
const client = await manager.control({
  workspaceHandle: incoming.workspaceHandle,
});
```

也可通过 `reins workspace handoff --repository <path> --commit <full-sha> --subdirectory <relative-path> --binding <ref>` 交接。Manager 连接由现有部署环境提供。返回的 `workspace` 是原生 runtime 准备事实；就绪前通过 `workspace.status` 查询，之后用其目标 cwd 创建会话。调用侧路径不作为目标执行路径。

仅这条缺少原生路径上下文的显式跨域链返回 WorkspaceHandle。句柄只能由同一消费者通过 `workspace.locate` 或 `manager.control({ workspaceHandle })` 使用；它寻址工作区，不是源码快照生命周期。已有原生 cwd 链不产生句柄。

每次交接创建新传入树，保留原 HEAD、index、文件及会话 cwd。固定输入不包含调用侧未提交文件；选定未提交内容另行处理。脱离 runtime 不删除输入源码，调用方可在会话结束后通过目标主机的原生 Git／文件动作清理工作树及对应对象库。

当前接受 SHA-1 固定提交和完整、非 thin Git pack。pack、单文件和目录清单的处理上限各为 32 MiB；超限、缺失对象、损坏材料、gitlink、无法精确保留的 checkout 属性及逃逸的目标子目录整体以 `source_invalid` 拒绝。支持普通文件、可执行位和符号链接，物化后逐项核对原始对象字节与属性。Git 环境忽略全局／系统配置和替换对象，不为调用方执行自定义过滤器或 hook。
