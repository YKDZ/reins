import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  ModelInfo,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@qodercn-ai/qodercn-agent-sdk";

export type {
  CanUseTool,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
};

export type QoderQuery = AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
};

export type QoderOptions = {
  cwd?: string;
  model?: string;
  includePartialMessages?: boolean;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: CanUseTool;
  persistSession?: boolean;
  abortController?: AbortController;
};

// adapter 只消费 query 与控制面，auth 由真实绑定注入（qodercliAuth）。
export type QoderSdk = {
  query(params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options?: QoderOptions;
  }): QoderQuery;
  // 实时模型目录：发送 get_models 控制请求，由 qodercli 响应。
  getAvailableModels(options?: {
    fetchStrategy?: "live" | "cache";
    uid?: string;
  }): Promise<ModelInfo[]>;
};
