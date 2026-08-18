# 会话状态机原型（七动作）

Status: ready-for-human

问题：spawn / send / wait / interrupt / kill / list / attach 构成的会话状态机，在难例下是否符合直觉——busy 中 send 的边界注入、interrupt→send 的部分产出保留、busy 中 kill、wait 超时后会话仍在运行、权限请求挂起与决议、幂等与非法操作。

原型：双击仓库根目录的 `PROTOTYPE-session-state-machine.html`，先依次走六个引导场景，再用左侧"自由操作"随意组合。

代码位置：throwaway 分支 `prototype/session-state-machine`（commit a22e075），不入 main。纯状态机模块在文件内"纯逻辑模块"`<script>` 段，验证通过后搬进 `packages/core`。

## Comments

- 原型因 oxfmt 会格式化失败，放在仓库根目录而非 `packages/core/` 内，root 任务清单不扫描该文件。
- v2（commit 77a3e70）：按反馈收窄入口——顶部四套"复杂状态预设"一键载入（并发三兄弟 / 中断再续 / kill 残局 / 排队轰炸），自由操作折叠为"高级"区，引导场景不再自动启动。
