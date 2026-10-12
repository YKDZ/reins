// 面向 CLI 使用者的说明文本使用简体中文；运行时语言检查仅在此文案模块放行中文。
export const cliCopy = {
  help: {
    headings: {
      usage: "用法",
      commands: "命令",
      arguments: "参数",
      options: "选项",
    },
    wording: {
      commandPlaceholder: "命令",
      choices: "可选值：{choices}",
      default: "默认值：{value}",
    },
  },
  rootDescription: "查询 Reins 控制面。",
  capabilities: {
    description: "查询当前 harness 能力。",
    resultDescription: "当前能力列表",
    failureDescription: "Reins 查询失败",
  },
  list: {
    description: "列出 Reins 会话及其当前状态。",
    fields: {
      session: "按精确会话句柄筛选。",
      harness: "按 harness 标识筛选。",
      state: "按当前会话状态筛选。",
      name: "按会话名称筛选。",
      model: "按模型标识筛选。",
    },
    resultDescription: "符合条件的会话",
    failureDescription: "Reins 查询失败",
  },
} as const;
