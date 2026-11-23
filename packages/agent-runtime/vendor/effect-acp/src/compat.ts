import * as Schema from "effect/Schema";
import type * as V1 from "./_generated/schema-v1.gen.ts";
import type * as V2 from "./_generated/schema.gen.ts";

type Meta = AcpMeta | null;
type AcpMeta = NonNullable<V2.InitializeRequest["_meta"]>;
type KnownContentBlock<T extends V2.ContentBlock["type"]> = Extract<
  V2.ContentBlock,
  { readonly type: T }
>;

/** Provider-neutral content accepted by Nodex after ACP v1 or v2 negotiation. */
export type ContentBlock =
  | KnownContentBlock<"text">
  | KnownContentBlock<"image">
  | KnownContentBlock<"audio">
  | KnownContentBlock<"resource_link">
  | KnownContentBlock<"resource">
  | {
      readonly type: "_unknown";
      readonly originalType: string;
      readonly raw: unknown;
    };

export type AbsolutePath = V2.AbsolutePath;
/** A slash command the Agent accepts as prompt text; skills and future kinds are not commands. */
export interface AvailableCommand {
  readonly name: string;
  readonly description: string;
  readonly input?: Extract<V2.AvailableCommandInput, { readonly type: "text" }> | null;
  readonly _meta?: Meta;
}
export type CloseSessionRequest = V2.CloseSessionRequest;
export type CloseSessionResponse = V2.CloseSessionResponse;
export type DeleteSessionRequest = V2.DeleteSessionRequest;
export type DeleteSessionResponse = V2.DeleteSessionResponse;
export type ListProvidersRequest = V2.ListProvidersRequest;
export type ListProvidersResponse = V2.ListProvidersResponse;
export type SetProviderRequest = V2.SetProviderRequest;
export type SetProviderResponse = V2.SetProviderResponse;
export type DisableProviderRequest = V2.DisableProviderRequest;
export type DisableProviderResponse = V2.DisableProviderResponse;
export type CompleteElicitationNotification = V2.CompleteElicitationNotification;
export type CreateElicitationRequest = V2.CreateElicitationRequest;
export type CreateElicitationResponse = V2.CreateElicitationResponse;
export type ElicitationContentValue = V2.ElicitationContentValue;
export type ForkSessionRequest = Omit<V2.ForkSessionRequest, "mcpServers"> & {
  readonly mcpServers?: ReadonlyArray<McpServer>;
};
export type ListSessionsRequest = V2.ListSessionsRequest;
export type ListSessionsResponse = V2.ListSessionsResponse;
export type LogoutResponse = V2.LogoutAuthResponse;
export type LogoutRequest = V2.LogoutAuthRequest;
/** v1's closed stop reasons, plus v2's failure and reasons from newer Agents. */
export type StopReason = V1.StopReason | "error" | (string & {});
export type Usage = V2.Usage;
export type TerminalExitStatus = V2.TerminalExitStatus;
export type ToolCallLocation = V2.ToolCallLocation;
export type ToolCallStatus = V2.ToolCallStatus;
export type ToolKind = V2.ToolKind;

export type ClientCapabilities = {
  readonly fs?: { readonly readTextFile?: boolean; readonly writeTextFile?: boolean };
  readonly terminal?: boolean;
  readonly session?: {
    readonly list?: Meta;
    readonly notices?: Meta;
    readonly compaction?: Meta;
  } | null;
  readonly plan?: Meta;
  readonly auth?: { readonly terminal?: boolean };
  readonly elicitation?: V2.ElicitationCapabilities | null;
  readonly _meta?: Meta;
};

export type InitializeRequest = {
  readonly protocolVersion: number;
  readonly clientCapabilities?: ClientCapabilities;
  readonly clientInfo?: V2.Implementation | null;
  readonly _meta?: Meta;
};

export type AgentCapabilities = {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: {
    readonly image?: boolean;
    readonly audio?: boolean;
    readonly embeddedContext?: boolean;
  };
  readonly mcpCapabilities?: {
    readonly stdio?: boolean;
    readonly http?: boolean;
    readonly sse?: boolean;
    readonly acp?: boolean;
  };
  readonly sessionCapabilities?: {
    readonly list?: Meta;
    readonly fork?: Meta;
    readonly resume?: Meta;
    readonly close?: Meta;
    readonly delete?: Meta;
    readonly additionalDirectories?: Meta;
  };
  readonly auth?: { readonly logout?: Meta };
  readonly providers?: Meta;
  readonly _meta?: Meta;
};

interface AuthMethodBase {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly _meta?: Meta;
}

export type AuthMethod =
  | (AuthMethodBase & {
      readonly type: "terminal";
      readonly args?: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
    })
  | (AuthMethodBase & {
      readonly type: "env_var";
      readonly vars: ReadonlyArray<{ readonly name: string; readonly label?: string }>;
      readonly link?: string | null;
    })
  | (AuthMethodBase & { readonly type?: "agent" });

export type InitializeResponse = {
  readonly protocolVersion: number;
  readonly agentCapabilities?: AgentCapabilities;
  readonly authMethods?: ReadonlyArray<AuthMethod>;
  readonly agentInfo?: V2.Implementation | null;
  readonly _meta?: Meta;
};

export type AuthenticateRequest = V2.LoginAuthRequest;
export type AuthenticateResponse = V2.LoginAuthResponse;
export type CancelNotification = V2.CancelSessionNotification;

export type McpServer =
  | {
      readonly name: string;
      readonly command: string;
      readonly args?: ReadonlyArray<string>;
      readonly env?: ReadonlyArray<V2.EnvVariable>;
      readonly _meta?: Meta;
    }
  | V2.McpServer;

export type NewSessionRequest = Omit<V2.NewSessionRequest, "mcpServers"> & {
  readonly mcpServers: ReadonlyArray<McpServer>;
};
export type ResumeSessionRequest = Omit<V2.ResumeSessionRequest, "mcpServers"> & {
  readonly mcpServers?: ReadonlyArray<McpServer>;
};
export type LoadSessionRequest = Omit<ResumeSessionRequest, "replayFrom">;

export interface SessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly _meta?: Meta;
}

export interface SessionModeState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<SessionMode>;
  readonly _meta?: Meta;
}

export interface LoadSessionResponse {
  readonly models?: SessionModelState | null;
  readonly modes?: SessionModeState | null;
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null;
  /** Present when a v2 setup response lists the session's commands; it replaces the earlier list. */
  readonly availableCommands?: ReadonlyArray<AvailableCommand>;
  readonly _meta?: Meta;
}

export interface NewSessionResponse extends LoadSessionResponse {
  readonly sessionId: string;
}

export type ResumeSessionResponse = LoadSessionResponse;
export interface ForkSessionResponse extends NewSessionResponse {}

export type SessionConfigSelectOption = V2.SessionConfigSelectOption;
export type SessionConfigSelectOptions =
  | ReadonlyArray<SessionConfigSelectOption>
  | ReadonlyArray<{
      readonly groupId: string;
      readonly name: string;
      readonly options: ReadonlyArray<SessionConfigSelectOption>;
      readonly _meta?: Meta;
    }>;

interface SessionConfigOptionBase {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly category?: string | null;
  readonly _meta?: Meta;
}

export type SessionConfigOption =
  | (SessionConfigOptionBase & {
      readonly type: "select";
      readonly currentValue: string;
      readonly options: SessionConfigSelectOptions;
    })
  | (SessionConfigOptionBase & {
      readonly type: "boolean";
      readonly currentValue: boolean;
    });

export type SetSessionConfigOptionRequest =
  | {
      readonly sessionId: string;
      readonly configId: string;
      readonly value: string;
      readonly _meta?: Meta;
    }
  | {
      readonly type: "boolean";
      readonly sessionId: string;
      readonly configId: string;
      readonly value: boolean;
      readonly _meta?: Meta;
    };

export interface SetSessionConfigOptionResponse {
  readonly configOptions: ReadonlyArray<SessionConfigOption>;
  readonly _meta?: Meta;
}

export interface SetSessionModeResponse {
  readonly _meta?: Meta;
}

export type PromptRequest = Omit<V2.PromptRequest, "prompt"> & {
  readonly prompt: ReadonlyArray<ContentBlock>;
};
export interface PromptResponse {
  readonly stopReason: StopReason;
  readonly usage?: V2.Usage | null;
  readonly error?: V2.Error | null;
  readonly _meta?: Meta;
}

export type ToolCallContent =
  | { readonly type: "content"; readonly content: ContentBlock; readonly _meta?: Meta }
  | {
      readonly type: "diff";
      readonly path: string;
      readonly oldText?: string | null;
      readonly newText: string;
      readonly _meta?: Meta;
    }
  | {
      readonly type: "diff";
      readonly changes: ReadonlyArray<V2.DiffChange>;
      readonly patch?: V2.DiffPatch | null;
      readonly _meta?: Meta;
    }
  | { readonly type: "terminal"; readonly terminalId: string; readonly _meta?: Meta }
  | {
      readonly type: "_unknown";
      readonly originalType: string;
      readonly raw: unknown;
    };

export interface ToolCallUpdate {
  readonly toolCallId: string;
  readonly name?: string | null;
  readonly title?: string | null;
  readonly kind?: ToolKind | null;
  readonly status?: ToolCallStatus | null;
  readonly content?: ReadonlyArray<ToolCallContent> | null;
  readonly locations?: ReadonlyArray<ToolCallLocation> | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly _meta?: Meta;
}

type MessageChunkUpdate = {
  readonly content: ContentBlock;
  readonly messageId?: string | null;
  readonly _meta?: Meta;
};

type MessageUpdate = {
  readonly messageId: string;
  readonly content?: ReadonlyArray<ContentBlock> | null;
  readonly _meta?: Meta;
};

/** A child session's foreground state as its parent reports it. */
export type SubagentState =
  | { readonly state: "running" | "requires_action" | "unknown"; readonly _meta?: Meta }
  | {
      readonly state: "idle";
      readonly stopReason?: StopReason | null;
      readonly error?: V2.Error | null;
      readonly _meta?: Meta;
    };

/** The parent announced or updated a child session it owns. */
export interface SubagentUpdate {
  readonly sessionId: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly state?: SubagentState | null;
  readonly _meta?: Meta;
}

/** A message one session sent another, viewed from the enclosing session. */
export interface SessionMessage {
  readonly messageId: string;
  readonly senderSessionId?: string | null;
  readonly recipientSessionId?: string | null;
  readonly content?: ReadonlyArray<ContentBlock> | null;
  readonly _meta?: Meta;
}

export type SessionUpdate =
  | (MessageChunkUpdate & { readonly sessionUpdate: "user_message_chunk" })
  | (MessageChunkUpdate & { readonly sessionUpdate: "agent_message_chunk" })
  | (MessageChunkUpdate & { readonly sessionUpdate: "agent_thought_chunk" })
  | (MessageUpdate & { readonly sessionUpdate: "user_message" })
  | (MessageUpdate & { readonly sessionUpdate: "agent_message" })
  | (MessageUpdate & { readonly sessionUpdate: "agent_thought" })
  | (ToolCallUpdate & { readonly sessionUpdate: "tool_call"; readonly title: string })
  | (ToolCallUpdate & { readonly sessionUpdate: "tool_call_update" })
  | {
      readonly sessionUpdate: "tool_call_content_chunk";
      readonly toolCallId: string;
      readonly content: ToolCallContent;
      readonly _meta?: Meta;
    }
  | {
      readonly sessionUpdate: "state_update";
      readonly state: "running";
      readonly _meta?: Meta;
    }
  | {
      readonly sessionUpdate: "state_update";
      readonly state: "idle";
      readonly stopReason?: StopReason | null;
      readonly usage?: Usage | null;
      readonly error?: V2.Error | null;
      readonly _meta?: Meta;
    }
  | {
      readonly sessionUpdate: "state_update";
      readonly state: "requires_action" | "unknown";
      readonly _meta?: Meta;
    }
  | Extract<V2.SessionUpdate, { readonly sessionUpdate: "terminal_update" }>
  | Extract<V2.SessionUpdate, { readonly sessionUpdate: "terminal_output_chunk" }>
  | Extract<V2.SessionUpdate, { readonly sessionUpdate: "plan_update" }>
  | Extract<V2.SessionUpdate, { readonly sessionUpdate: "plan_removed" }>
  | {
      readonly sessionUpdate: "available_commands_update";
      readonly availableCommands: ReadonlyArray<AvailableCommand>;
      readonly _meta?: Meta;
    }
  | Extract<V2.SessionUpdate, { readonly sessionUpdate: "session_info_update" }>
  | Extract<V2.SessionUpdate, { readonly sessionUpdate: "usage_update" }>
  | {
      readonly sessionUpdate: "compaction_update";
      readonly compactionId: string;
      /** Omitted keeps the compaction's previous status. */
      readonly status?: string | null;
      readonly summary?: ReadonlyArray<ContentBlock> | null;
      readonly error?: string | null;
      readonly _meta?: Meta;
    }
  | {
      readonly sessionUpdate: "compaction_summary_chunk";
      readonly compactionId: string;
      readonly content: ContentBlock;
      readonly _meta?: Meta;
    }
  | {
      readonly sessionUpdate: "config_option_update";
      readonly configOptions: ReadonlyArray<SessionConfigOption>;
      readonly _meta?: Meta;
    }
  | { readonly sessionUpdate: "plan"; readonly entries: ReadonlyArray<V2.PlanEntry> }
  | { readonly sessionUpdate: "current_mode_update"; readonly currentModeId: string }
  | {
      readonly sessionUpdate: "notice";
      readonly severity: string;
      readonly title: string;
      readonly description?: string | null;
      readonly _meta?: Meta;
    }
  | (SubagentUpdate & { readonly sessionUpdate: "subagent_update" })
  | (SessionMessage & { readonly sessionUpdate: "session_message" })
  | (MessageChunkUpdate & {
      readonly sessionUpdate: "session_message_chunk";
      readonly messageId: string;
    })
  /** ACP v2 marks the end of a requested history replay. */
  | { readonly sessionUpdate: "replay_complete"; readonly _meta?: Meta }
  // Known updates Nodex does not present: fork cursors and prompt suggestions.
  | Extract<V2.SessionUpdate, { readonly sessionUpdate: "cursor_update" }>
  | Extract<V2.SessionUpdate, { readonly sessionUpdate: "prompt_suggestions_update" }>
  | {
      readonly sessionUpdate: "_unknown";
      readonly originalSessionUpdate: string;
      readonly raw: unknown;
    };

export interface SessionNotification {
  readonly sessionId: string;
  readonly update: SessionUpdate;
  readonly _meta?: Meta;
}

export type RequestPermissionRequest = {
  readonly sessionId: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly subject?: V2.RequestPermissionSubject | null;
  readonly toolCall: ToolCallUpdate;
  readonly options: ReadonlyArray<V2.PermissionOption>;
  readonly _meta?: Meta;
};
export type RequestPermissionResponse = V2.RequestPermissionResponse;

// ACP v1 client-mediated filesystem and terminal shapes remain as internal
// types for the legacy policy helpers. ACP v2 never advertises or wires them.
export interface ReadTextFileRequest {
  readonly sessionId: string;
  readonly path: string;
  readonly line?: number | null;
  readonly limit?: number | null;
}
export interface ReadTextFileResponse {
  readonly content: string;
}
export interface WriteTextFileRequest {
  readonly sessionId: string;
  readonly path: string;
  readonly content: string;
}
export interface WriteTextFileResponse {}
export interface CreateTerminalRequest {
  readonly sessionId: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: ReadonlyArray<V2.EnvVariable>;
  readonly cwd?: string | null;
  readonly outputByteLimit?: number | null;
}
export interface CreateTerminalResponse {
  readonly terminalId: string;
}
interface TerminalRequest {
  readonly sessionId: string;
  readonly terminalId: string;
}
export type TerminalOutputRequest = TerminalRequest;
export interface TerminalOutputResponse {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus?: TerminalExitStatus | null;
}
export type WaitForTerminalExitRequest = TerminalRequest;
export type WaitForTerminalExitResponse = TerminalExitStatus;
export type KillTerminalRequest = TerminalRequest;
export interface KillTerminalResponse {}
export type ReleaseTerminalRequest = TerminalRequest;
export interface ReleaseTerminalResponse {}

// Older v1 agents still advertise and select models through this removed unstable API.
const LegacyMeta = Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Json)));
export const ModelInfo = Schema.Struct({
  modelId: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  _meta: LegacyMeta,
});
export type ModelInfo = typeof ModelInfo.Type;
export const SessionModelState = Schema.Struct({
  currentModelId: Schema.String,
  availableModels: Schema.Array(ModelInfo),
  _meta: LegacyMeta,
});
export type SessionModelState = typeof SessionModelState.Type;
export const SetSessionModelRequest = Schema.Struct({
  sessionId: Schema.String,
  modelId: Schema.String,
  _meta: LegacyMeta,
});
export type SetSessionModelRequest = typeof SetSessionModelRequest.Type;
export const SetSessionModelResponse = Schema.Struct({ _meta: LegacyMeta });
export type SetSessionModelResponse = typeof SetSessionModelResponse.Type;
export type PermissionOption = V2.PermissionOption;
