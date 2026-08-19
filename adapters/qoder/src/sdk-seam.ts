import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@qodercn-ai/qodercn-agent-sdk";

export type {
  CanUseTool,
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
};
