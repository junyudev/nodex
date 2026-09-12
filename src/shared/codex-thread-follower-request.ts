import type { CommandExecutionApprovalDecision } from "@nodex/codex-app-server-protocol/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "@nodex/codex-app-server-protocol/v2/FileChangeApprovalDecision";
import type { McpServerElicitationRequestResponse } from "@nodex/codex-app-server-protocol/v2/McpServerElicitationRequestResponse";
import type { PermissionsRequestApprovalResponse } from "@nodex/codex-app-server-protocol/v2/PermissionsRequestApprovalResponse";
import type { ToolRequestUserInputResponse } from "@nodex/codex-app-server-protocol/v2/ToolRequestUserInputResponse";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2/TurnStartParams";
import type { TurnSteerParams } from "@nodex/codex-app-server-protocol/v2/TurnSteerParams";
import type { RequestId } from "@nodex/codex-app-server-protocol";

/** Transport carries a prepared native request; owners must not reconstruct it from composer text. */
export interface ConversationFollowerTurnStart {
  request: TurnStartParams;
  context?: {
    localTurnMetadata?: unknown;
    attachments?: unknown;
    commentAttachments?: unknown;
    useAppServerPermissionDefault?: boolean;
    usePermissionSelection?: boolean;
    inheritThreadSettings?: boolean;
    writingBlockContextPrepared?: boolean;
    threadStartKind?: unknown;
    mcpAppModelContextAttachments?: unknown;
    responseItems?: unknown;
  };
}

type Conversation = { conversationId: string };
type Request = Conversation & { requestId: RequestId };
export interface ConversationFollowerParams {
  "thread-follower-set-queued-follow-ups-state": Conversation & {
    state: Record<string, readonly unknown[]>;
  };
  "thread-follower-command-approval-decision": Request & {
    decision: CommandExecutionApprovalDecision;
  };
  "thread-follower-file-approval-decision": Request & { decision: FileChangeApprovalDecision };
  "thread-follower-permissions-request-approval-response": Request & {
    response: PermissionsRequestApprovalResponse;
  };
  "thread-follower-submit-mcp-server-elicitation-response": Request & {
    response: McpServerElicitationRequestResponse;
  };
  "thread-follower-submit-user-input": Request & { response: ToolRequestUserInputResponse };
  "thread-follower-compact-thread": Conversation;
  "thread-follower-edit-last-user-turn": Conversation & {
    turnId: string;
    message: string;
    agentMode?: unknown;
    shouldSendPermissionOverrides?: boolean;
    serviceTier?: TurnStartParams["serviceTier"];
    additionalContext?: unknown;
    writingBlockContextPrepared?: boolean;
  };
  "thread-follower-interrupt-turn": Conversation & {
    mode: "user-stop" | "system" | "descendant-cleanup";
    expectedTurnId?: string;
  };
  "thread-follower-load-complete-history": Conversation;
  "thread-follower-start-turn": Conversation & { turnStart: ConversationFollowerTurnStart };
  "thread-follower-steer-turn": Conversation & {
    input: TurnSteerParams["input"];
    restoreMessage: unknown;
    serviceTier?: TurnStartParams["serviceTier"];
    attachments?: unknown;
    clientUserMessageId?: string;
    additionalContext?: unknown;
    toolOutput?: unknown;
  };
  "thread-follower-update-thread-settings": Conversation & {
    threadSettings: unknown;
    condition?: unknown;
    activeTurnId?: string | null;
  };
}
export type ConversationFollowerMethod = keyof ConversationFollowerParams;
export type NativeConversationFollowerRequest = {
  [Method in ConversationFollowerMethod]: {
    method: Method;
    params: ConversationFollowerParams[Method];
  };
}[ConversationFollowerMethod];

/** Field-preserving construction keeps native payloads intact across the peer service. */
export const conversationFollowerRequest = <Method extends ConversationFollowerMethod>(
  method: Method,
  params: ConversationFollowerParams[Method],
): { method: Method; params: ConversationFollowerParams[Method] } => ({ method, params });
