import type { RequestId } from "@nodex/codex-app-server-protocol";
import type { CommandExecutionRequestApprovalResponse } from "@nodex/codex-app-server-protocol/v2/CommandExecutionRequestApprovalResponse";
import type { FileChangeRequestApprovalResponse } from "@nodex/codex-app-server-protocol/v2/FileChangeRequestApprovalResponse";
import type { ToolRequestUserInputResponse } from "@nodex/codex-app-server-protocol/v2/ToolRequestUserInputResponse";
import type { PermissionsRequestApprovalResponse } from "@nodex/codex-app-server-protocol/v2/PermissionsRequestApprovalResponse";
import type { McpServerElicitationRequestResponse } from "@nodex/codex-app-server-protocol/v2/McpServerElicitationRequestResponse";
import type {
  CodexCanonicalOptionPickerResponse,
  CodexCanonicalSetupContextPickerResponse,
} from "./codex-conversation-state/codex-conversation-state";
import type { CodexServerRequestAutoResponseEffect } from "./codex-conversation-state/codex-server-request-lifecycle";
import type { CodexRequestTraceContext } from "./codex-request-lifecycle";
type ServerRequestResponsesByMethod = {
  "item/commandExecution/requestApproval": CommandExecutionRequestApprovalResponse;
  "item/fileChange/requestApproval": FileChangeRequestApprovalResponse;
  "item/tool/requestUserInput": ToolRequestUserInputResponse;
  "item/permissions/requestApproval": PermissionsRequestApprovalResponse;
  "mcpServer/elicitation/request": McpServerElicitationRequestResponse;
  "item/tool/requestOptionPicker": CodexCanonicalOptionPickerResponse;
  "item/tool/requestSetupCodexContextPicker": CodexCanonicalSetupContextPickerResponse;
};
import type { CodexNativeIngressIdentity } from "./types";

export interface CodexNativeServerResponseTraceMetadata {
  readonly requestMethod?: string;
  readonly trace?: CodexRequestTraceContext | null;
}

export type CodexNativeUserResponseMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/tool/requestUserInput"
  | "item/permissions/requestApproval"
  | "mcpServer/elicitation/request"
  | "item/tool/requestOptionPicker"
  | "item/tool/requestSetupCodexContextPicker";
export type CodexNativeUserResponse = {
  [Method in CodexNativeUserResponseMethod]: {
    readonly method: Method;
    readonly requestId: RequestId;
    readonly response: ServerRequestResponsesByMethod[Method];
  };
}[CodexNativeUserResponseMethod];
export type CodexNativeUserResponseInput = CodexNativeIngressIdentity &
  CodexNativeUserResponse &
  CodexNativeServerResponseTraceMetadata & { readonly threadId: string };

export type CodexNativeAutoResponseInput = CodexNativeIngressIdentity &
  CodexNativeServerResponseTraceMetadata & {
    readonly effect: CodexServerRequestAutoResponseEffect;
  };

export type CodexNativeServerResponseInput =
  | CodexNativeUserResponseInput
  | CodexNativeAutoResponseInput;
