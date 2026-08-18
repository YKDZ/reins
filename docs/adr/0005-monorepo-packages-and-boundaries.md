# monorepo 包结构与边界策略

包布局是三层架构在 monorepo 里的直接投影，全部经 `@ykdz/template add package` 创建、用 `--link-from` 建立关系：`packages/core`（`@reins/core`）为接口层核心；`packages/protocol` 承载七动作与领域事件的 schema；`packages/adapter-kit` 放 adapter 共享工具；`adapters/codex`、`adapters/dsh`、`adapters/qoder` 是 v1 的三个 worker adapter；`apps/cli`（`@reins/cli`，二进制名 `reins`）只依赖 protocol 而不依赖核心包——薄客户端经内部协议与 daemon 通信，这既符合 ADR-0002，也受模板工具"新建包只能作为 provider 建链"的约束所迫。

`@reins/core` 是由模板初始包 `@reins/reins`（`packages/reins`）改名而来。这是明知会牺牲模板工具兼容性的取舍：`add package` 会用预设 ts-lib 与仓库目录名重新推导初始包，硬性要求 `@reins/reins` 在 `packages/reins` 原样存在（报错"expects initial Blueprint packages packages/reins"），元数据无法绕过；为命名清晰仍决定改名，代价是此后新建包不能再走 `add package`。`@reins/cli`（原名 `@reins/reins-cli`）是 addition 包，重建依据是 blueprint 名/路径，改名不影响工具。

依赖方向由 turbo boundaries 机械保证：`app` 允许 `protocol`；`adapter` 允许 `protocol`、`adapter-kit`；`adapter-kit` 与 `core` 允许 `protocol`；`protocol` 无依赖；所有标签都额外放行 `library`（typescript-config 的 devDep 边，boundaries 会检查 devDependencies）。adapter 与 app 不出现在任何 allow 列表里，因此天然是叶子，core 依赖不了 adapter，adapter 之间也互不可见；CI 里的 `pnpm check` 每次都会执行该检查。
