# 共享客户端

`createWorkspaceClient` 绑定消费者上下文。发布查询与读取通过 Manager 校验所有权，本地接收和 Git 导入在消费者一侧执行。

消费者可以调用 `importGitPublication(publicationId, { repository, reference, commit })`，或使用：

```sh
reins workspace import-git <publication> --repository /path/to/repository --ref refs/received/result --commit <full-commit-object-name>
```

worker 先用原生 Git 准备提交和 bundle，再明确发布该文件。导入只接受 bundle 中明确公布的提交；前置对象必须已存在或包含在包中。普通文件不会被转成提交。目标必须是不存在的完整引用，不能是当前分支；已有引用、符号引用及并发同名创建都不能被替换。

成功结果包含原发布事实、目标仓库、提交、新引用及引用创建事实。`objectWriteAttempted` 表示是否开始导入对象，`objectDatabaseBefore` 和 `objectDatabaseAfter` 是各次原生 `git count-objects -v` 观察到的松散对象、打包对象和包数量。它们不是并发仓库操作的原子快照，也不把其他调用方的并发写入归因于本次导入。`git_import_failed` 保留同样的变化字段：例如引用竞争失败时，对象可能已写入，但引用没有创建；不会因此删除可能被其他引用共用的 Git 对象。

导入不更新 HEAD、index 或工作文件，不执行检出、合并、推送或冲突处理。后续原生 Git 操作由调用方选择；本地接收副本与远端发布副本也不会因为导入而被清理。
