// Generated from the staged Nodex Codex runtime. Do not edit manually.

import * as CodexSchema from "./schema.gen.ts";
import * as Schema from "effect/Schema";

export const CLIENT_REQUEST_METHODS = {
  initialize: "initialize",
  "server/diagnostics": "server/diagnostics",
  "thread/start": "thread/start",
  "thread/resume": "thread/resume",
  "thread/fork": "thread/fork",
  "thread/archive": "thread/archive",
  "thread/delete": "thread/delete",
  "thread/unsubscribe": "thread/unsubscribe",
  "thread/increment_elicitation": "thread/increment_elicitation",
  "thread/decrement_elicitation": "thread/decrement_elicitation",
  "thread/name/set": "thread/name/set",
  "thread/goal/set": "thread/goal/set",
  "thread/goal/get": "thread/goal/get",
  "thread/goal/clear": "thread/goal/clear",
  "thread/queue/add": "thread/queue/add",
  "thread/queue/list": "thread/queue/list",
  "thread/queue/update": "thread/queue/update",
  "thread/queue/delete": "thread/queue/delete",
  "thread/queue/reorder": "thread/queue/reorder",
  "thread/queue/start": "thread/queue/start",
  "thread/metadata/update": "thread/metadata/update",
  "thread/section/move": "thread/section/move",
  "thread/settings/update": "thread/settings/update",
  "thread/memoryMode/set": "thread/memoryMode/set",
  "memory/reset": "memory/reset",
  "thread/unarchive": "thread/unarchive",
  "thread/compact/start": "thread/compact/start",
  "thread/shellCommand": "thread/shellCommand",
  "thread/approveGuardianDeniedAction": "thread/approveGuardianDeniedAction",
  "thread/backgroundTerminals/clean": "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/list": "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate": "thread/backgroundTerminals/terminate",
  "thread/rollback": "thread/rollback",
  "thread/revert": "thread/revert",
  "thread/list": "thread/list",
  "project/list": "project/list",
  "project/read": "project/read",
  "project/create": "project/create",
  "project/import": "project/import",
  "project/update": "project/update",
  "project/move": "project/move",
  "project/delete": "project/delete",
  "threadSection/list": "threadSection/list",
  "threadSection/create": "threadSection/create",
  "threadSection/update": "threadSection/update",
  "threadSection/delete": "threadSection/delete",
  "thread/search": "thread/search",
  "thread/searchOccurrences": "thread/searchOccurrences",
  "thread/loaded/list": "thread/loaded/list",
  "thread/read": "thread/read",
  "thread/turns/list": "thread/turns/list",
  "thread/items/list": "thread/items/list",
  "thread/inject_items": "thread/inject_items",
  "skills/list": "skills/list",
  "skills/extraRoots/set": "skills/extraRoots/set",
  "hooks/list": "hooks/list",
  "marketplace/add": "marketplace/add",
  "marketplace/remove": "marketplace/remove",
  "marketplace/upgrade": "marketplace/upgrade",
  "plugin/list": "plugin/list",
  "plugin/search": "plugin/search",
  "plugin/installed": "plugin/installed",
  "plugin/read": "plugin/read",
  "plugin/skill/read": "plugin/skill/read",
  "plugin/share/save": "plugin/share/save",
  "plugin/share/updateTargets": "plugin/share/updateTargets",
  "plugin/share/list": "plugin/share/list",
  "plugin/share/checkout": "plugin/share/checkout",
  "plugin/share/delete": "plugin/share/delete",
  "app/read": "app/read",
  "app/list": "app/list",
  "app/installed": "app/installed",
  "fs/readFile": "fs/readFile",
  "fs/writeFile": "fs/writeFile",
  "fs/createDirectory": "fs/createDirectory",
  "fs/getMetadata": "fs/getMetadata",
  "fs/readDirectory": "fs/readDirectory",
  "fs/remove": "fs/remove",
  "fs/copy": "fs/copy",
  "fs/watch": "fs/watch",
  "fs/unwatch": "fs/unwatch",
  "skills/config/write": "skills/config/write",
  "plugin/install": "plugin/install",
  "plugin/uninstall": "plugin/uninstall",
  "turn/start": "turn/start",
  "turn/settings/update": "turn/settings/update",
  "turn/steer": "turn/steer",
  "turn/interrupt": "turn/interrupt",
  "thread/realtime/start": "thread/realtime/start",
  "thread/realtime/appendAudio": "thread/realtime/appendAudio",
  "thread/realtime/appendText": "thread/realtime/appendText",
  "thread/realtime/appendSpeech": "thread/realtime/appendSpeech",
  "thread/realtime/stop": "thread/realtime/stop",
  "thread/timeline/list": "thread/timeline/list",
  "thread/realtime/listVoices": "thread/realtime/listVoices",
  "review/start": "review/start",
  "model/list": "model/list",
  "modelProvider/capabilities/read": "modelProvider/capabilities/read",
  "experimentalFeature/list": "experimentalFeature/list",
  "permissionProfile/list": "permissionProfile/list",
  "experimentalFeature/enablement/set": "experimentalFeature/enablement/set",
  "remoteControl/enable": "remoteControl/enable",
  "remoteControl/disable": "remoteControl/disable",
  "remoteControl/status/read": "remoteControl/status/read",
  "remoteControl/pairing/start": "remoteControl/pairing/start",
  "remoteControl/pairing/status": "remoteControl/pairing/status",
  "remoteControl/client/list": "remoteControl/client/list",
  "remoteControl/client/revoke": "remoteControl/client/revoke",
  "collaborationMode/list": "collaborationMode/list",
  "mock/experimentalMethod": "mock/experimentalMethod",
  "environment/add": "environment/add",
  "environment/info": "environment/info",
  "environment/status": "environment/status",
  "mcpServer/oauth/login": "mcpServer/oauth/login",
  "config/mcpServer/reload": "config/mcpServer/reload",
  "mcpServerStatus/list": "mcpServerStatus/list",
  "mcpServer/resource/read": "mcpServer/resource/read",
  "mcpServer/event/stream/start": "mcpServer/event/stream/start",
  "mcpServer/event/stream/stop": "mcpServer/event/stream/stop",
  "mcpServer/tool/call": "mcpServer/tool/call",
  "windowsSandbox/setupStart": "windowsSandbox/setupStart",
  "windowsSandbox/readiness": "windowsSandbox/readiness",
  "account/login/start": "account/login/start",
  "account/bedrock/discover": "account/bedrock/discover",
  "account/bedrock/setup": "account/bedrock/setup",
  "account/login/cancel": "account/login/cancel",
  "account/logout": "account/logout",
  "account/rateLimits/read": "account/rateLimits/read",
  "account/rateLimitResetCredit/consume": "account/rateLimitResetCredit/consume",
  "account/usage/read": "account/usage/read",
  "account/workspaceMessages/read": "account/workspaceMessages/read",
  "account/sendAddCreditsNudgeEmail": "account/sendAddCreditsNudgeEmail",
  "feedback/upload": "feedback/upload",
  "command/exec": "command/exec",
  "command/exec/write": "command/exec/write",
  "command/exec/terminate": "command/exec/terminate",
  "command/exec/resize": "command/exec/resize",
  "process/spawn": "process/spawn",
  "process/writeStdin": "process/writeStdin",
  "process/kill": "process/kill",
  "process/resizePty": "process/resizePty",
  "config/read": "config/read",
  "externalAgentConfig/detect": "externalAgentConfig/detect",
  "externalAgentConfig/import": "externalAgentConfig/import",
  "externalAgentConfig/import/recordHistory": "externalAgentConfig/import/recordHistory",
  "externalAgentConfig/import/readHistories": "externalAgentConfig/import/readHistories",
  "config/value/write": "config/value/write",
  "config/batchWrite": "config/batchWrite",
  "configRequirements/read": "configRequirements/read",
  "account/read": "account/read",
  getConversationSummary: "getConversationSummary",
  gitDiffToRemote: "gitDiffToRemote",
  getAuthStatus: "getAuthStatus",
  fuzzyFileSearch: "fuzzyFileSearch",
  "fuzzyFileSearch/sessionStart": "fuzzyFileSearch/sessionStart",
  "fuzzyFileSearch/sessionUpdate": "fuzzyFileSearch/sessionUpdate",
  "fuzzyFileSearch/sessionStop": "fuzzyFileSearch/sessionStop",
} as const;

export const CLIENT_NOTIFICATION_METHODS = {
  initialized: "initialized",
} as const;

export const SERVER_REQUEST_METHODS = {
  "item/commandExecution/requestApproval": "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval": "item/fileChange/requestApproval",
  "item/tool/requestUserInput": "item/tool/requestUserInput",
  "mcpServer/elicitation/request": "mcpServer/elicitation/request",
  "item/permissions/requestApproval": "item/permissions/requestApproval",
  "item/tool/call": "item/tool/call",
  "account/chatgptAuthTokens/refresh": "account/chatgptAuthTokens/refresh",
  "attestation/generate": "attestation/generate",
  "currentTime/read": "currentTime/read",
  applyPatchApproval: "applyPatchApproval",
  execCommandApproval: "execCommandApproval",
} as const;

export const SERVER_NOTIFICATION_METHODS = {
  error: "error",
  "thread/started": "thread/started",
  "thread/status/changed": "thread/status/changed",
  "thread/archived": "thread/archived",
  "thread/deleted": "thread/deleted",
  "thread/unarchived": "thread/unarchived",
  "thread/closed": "thread/closed",
  "thread/reverted": "thread/reverted",
  "skills/changed": "skills/changed",
  "thread/name/updated": "thread/name/updated",
  "thread/goal/updated": "thread/goal/updated",
  "thread/goal/cleared": "thread/goal/cleared",
  "thread/queue/changed": "thread/queue/changed",
  "project/changed": "project/changed",
  "thread/project/updated": "thread/project/updated",
  "thread/environment/connected": "thread/environment/connected",
  "thread/environment/disconnected": "thread/environment/disconnected",
  "thread/settings/updated": "thread/settings/updated",
  "thread/tokenUsage/updated": "thread/tokenUsage/updated",
  "turn/started": "turn/started",
  "hook/started": "hook/started",
  "turn/completed": "turn/completed",
  "hook/completed": "hook/completed",
  "turn/diff/updated": "turn/diff/updated",
  "turn/plan/updated": "turn/plan/updated",
  "item/started": "item/started",
  "item/autoApprovalReview/started": "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed": "item/autoApprovalReview/completed",
  "autoApprovalReview/strictReviewRequired": "autoApprovalReview/strictReviewRequired",
  "item/completed": "item/completed",
  "rawResponseItem/completed": "rawResponseItem/completed",
  "rawResponse/completed": "rawResponse/completed",
  "item/agentMessage/delta": "item/agentMessage/delta",
  "item/plan/delta": "item/plan/delta",
  "command/exec/outputDelta": "command/exec/outputDelta",
  "process/outputDelta": "process/outputDelta",
  "process/exited": "process/exited",
  "item/commandExecution/outputDelta": "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction": "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta": "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated": "item/fileChange/patchUpdated",
  "serverRequest/resolved": "serverRequest/resolved",
  "item/mcpToolCall/progress": "item/mcpToolCall/progress",
  "mcpServer/oauthLogin/completed": "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated": "mcpServer/startupStatus/updated",
  "mcpServer/event/stream/notification": "mcpServer/event/stream/notification",
  "account/updated": "account/updated",
  "account/rateLimits/updated": "account/rateLimits/updated",
  "app/list/updated": "app/list/updated",
  "remoteControl/status/changed": "remoteControl/status/changed",
  "externalAgentConfig/import/progress": "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed": "externalAgentConfig/import/completed",
  "fs/changed": "fs/changed",
  "item/reasoning/summaryTextDelta": "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded": "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta": "item/reasoning/textDelta",
  "thread/compacted": "thread/compacted",
  "model/rerouted": "model/rerouted",
  "model/verification": "model/verification",
  "modelProvider/authRecoveryStarted": "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted": "modelProvider/authRecoveryCompleted",
  "turn/moderationMetadata": "turn/moderationMetadata",
  "model/safetyBuffering/updated": "model/safetyBuffering/updated",
  warning: "warning",
  guardianWarning: "guardianWarning",
  deprecationNotice: "deprecationNotice",
  configWarning: "configWarning",
  "fuzzyFileSearch/sessionUpdated": "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted": "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started": "thread/realtime/started",
  "thread/realtime/itemAdded": "thread/realtime/itemAdded",
  "thread/realtime/item/started": "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta": "thread/realtime/item/transcript/delta",
  "thread/realtime/item/completed": "thread/realtime/item/completed",
  "thread/realtime/transcript/delta": "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done": "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta": "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp": "thread/realtime/sdp",
  "thread/realtime/error": "thread/realtime/error",
  "thread/realtime/closed": "thread/realtime/closed",
  "windows/worldWritableWarning": "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted": "windowsSandbox/setupCompleted",
  "account/login/completed": "account/login/completed",
} as const;

export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;
export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_METHODS;
export type ServerRequestMethod = keyof typeof SERVER_REQUEST_METHODS;
export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_METHODS;

export interface ClientRequestParamsByMethod {
  readonly initialize: CodexSchema.V1InitializeParams;
  readonly "server/diagnostics": CodexSchema.V2ServerDiagnosticsParams;
  readonly "thread/start": CodexSchema.V2ThreadStartParams;
  readonly "thread/resume": CodexSchema.V2ThreadResumeParams;
  readonly "thread/fork": CodexSchema.V2ThreadForkParams;
  readonly "thread/archive": CodexSchema.V2ThreadArchiveParams;
  readonly "thread/delete": CodexSchema.V2ThreadDeleteParams;
  readonly "thread/unsubscribe": CodexSchema.V2ThreadUnsubscribeParams;
  readonly "thread/increment_elicitation": CodexSchema.V2ThreadIncrementElicitationParams;
  readonly "thread/decrement_elicitation": CodexSchema.V2ThreadDecrementElicitationParams;
  readonly "thread/name/set": CodexSchema.V2ThreadSetNameParams;
  readonly "thread/goal/set": CodexSchema.V2ThreadGoalSetParams;
  readonly "thread/goal/get": CodexSchema.V2ThreadGoalGetParams;
  readonly "thread/goal/clear": CodexSchema.V2ThreadGoalClearParams;
  readonly "thread/queue/add": CodexSchema.V2ThreadQueueAddParams;
  readonly "thread/queue/list": CodexSchema.V2ThreadQueueListParams;
  readonly "thread/queue/update": CodexSchema.V2ThreadQueueUpdateParams;
  readonly "thread/queue/delete": CodexSchema.V2ThreadQueueDeleteParams;
  readonly "thread/queue/reorder": CodexSchema.V2ThreadQueueReorderParams;
  readonly "thread/queue/start": CodexSchema.V2ThreadQueueStartParams;
  readonly "thread/metadata/update": CodexSchema.V2ThreadMetadataUpdateParams;
  readonly "thread/section/move": CodexSchema.V2ThreadSectionMoveParams;
  readonly "thread/settings/update": CodexSchema.V2ThreadSettingsUpdateParams;
  readonly "thread/memoryMode/set": CodexSchema.V2ThreadMemoryModeSetParams;
  readonly "memory/reset": undefined;
  readonly "thread/unarchive": CodexSchema.V2ThreadUnarchiveParams;
  readonly "thread/compact/start": CodexSchema.V2ThreadCompactStartParams;
  readonly "thread/shellCommand": CodexSchema.V2ThreadShellCommandParams;
  readonly "thread/approveGuardianDeniedAction": CodexSchema.V2ThreadApproveGuardianDeniedActionParams;
  readonly "thread/backgroundTerminals/clean": CodexSchema.V2ThreadBackgroundTerminalsCleanParams;
  readonly "thread/backgroundTerminals/list": CodexSchema.V2ThreadBackgroundTerminalsListParams;
  readonly "thread/backgroundTerminals/terminate": CodexSchema.V2ThreadBackgroundTerminalsTerminateParams;
  readonly "thread/rollback": CodexSchema.V2ThreadRollbackParams;
  readonly "thread/revert": CodexSchema.V2ThreadRevertParams;
  readonly "thread/list": CodexSchema.V2ThreadListParams;
  readonly "project/list": CodexSchema.V2ProjectListParams;
  readonly "project/read": CodexSchema.V2ProjectReadParams;
  readonly "project/create": CodexSchema.V2ProjectCreateParams;
  readonly "project/import": CodexSchema.V2ProjectImportParams;
  readonly "project/update": CodexSchema.V2ProjectUpdateParams;
  readonly "project/move": CodexSchema.V2ProjectMoveParams;
  readonly "project/delete": CodexSchema.V2ProjectDeleteParams;
  readonly "threadSection/list": CodexSchema.V2ThreadSectionListParams;
  readonly "threadSection/create": CodexSchema.V2ThreadSectionCreateParams;
  readonly "threadSection/update": CodexSchema.V2ThreadSectionUpdateParams;
  readonly "threadSection/delete": CodexSchema.V2ThreadSectionDeleteParams;
  readonly "thread/search": CodexSchema.V2ThreadSearchParams;
  readonly "thread/searchOccurrences": CodexSchema.V2ThreadSearchOccurrencesParams;
  readonly "thread/loaded/list": CodexSchema.V2ThreadLoadedListParams;
  readonly "thread/read": CodexSchema.V2ThreadReadParams;
  readonly "thread/turns/list": CodexSchema.V2ThreadTurnsListParams;
  readonly "thread/items/list": CodexSchema.V2ThreadItemsListParams;
  readonly "thread/inject_items": CodexSchema.V2ThreadInjectItemsParams;
  readonly "skills/list": CodexSchema.V2SkillsListParams;
  readonly "skills/extraRoots/set": CodexSchema.V2SkillsExtraRootsSetParams;
  readonly "hooks/list": CodexSchema.V2HooksListParams;
  readonly "marketplace/add": CodexSchema.V2MarketplaceAddParams;
  readonly "marketplace/remove": CodexSchema.V2MarketplaceRemoveParams;
  readonly "marketplace/upgrade": CodexSchema.V2MarketplaceUpgradeParams;
  readonly "plugin/list": CodexSchema.V2PluginListParams;
  readonly "plugin/search": CodexSchema.V2PluginSearchParams;
  readonly "plugin/installed": CodexSchema.V2PluginInstalledParams;
  readonly "plugin/read": CodexSchema.V2PluginReadParams;
  readonly "plugin/skill/read": CodexSchema.V2PluginSkillReadParams;
  readonly "plugin/share/save": CodexSchema.V2PluginShareSaveParams;
  readonly "plugin/share/updateTargets": CodexSchema.V2PluginShareUpdateTargetsParams;
  readonly "plugin/share/list": CodexSchema.V2PluginShareListParams;
  readonly "plugin/share/checkout": CodexSchema.V2PluginShareCheckoutParams;
  readonly "plugin/share/delete": CodexSchema.V2PluginShareDeleteParams;
  readonly "app/read": CodexSchema.V2AppsReadParams;
  readonly "app/list": CodexSchema.V2AppsListParams;
  readonly "app/installed": CodexSchema.V2AppsInstalledParams;
  readonly "fs/readFile": CodexSchema.V2FsReadFileParams;
  readonly "fs/writeFile": CodexSchema.V2FsWriteFileParams;
  readonly "fs/createDirectory": CodexSchema.V2FsCreateDirectoryParams;
  readonly "fs/getMetadata": CodexSchema.V2FsGetMetadataParams;
  readonly "fs/readDirectory": CodexSchema.V2FsReadDirectoryParams;
  readonly "fs/remove": CodexSchema.V2FsRemoveParams;
  readonly "fs/copy": CodexSchema.V2FsCopyParams;
  readonly "fs/watch": CodexSchema.V2FsWatchParams;
  readonly "fs/unwatch": CodexSchema.V2FsUnwatchParams;
  readonly "skills/config/write": CodexSchema.V2SkillsConfigWriteParams;
  readonly "plugin/install": CodexSchema.V2PluginInstallParams;
  readonly "plugin/uninstall": CodexSchema.V2PluginUninstallParams;
  readonly "turn/start": CodexSchema.V2TurnStartParams;
  readonly "turn/settings/update": CodexSchema.V2TurnSettingsUpdateParams;
  readonly "turn/steer": CodexSchema.V2TurnSteerParams;
  readonly "turn/interrupt": CodexSchema.V2TurnInterruptParams;
  readonly "thread/realtime/start": CodexSchema.V2ThreadRealtimeStartParams;
  readonly "thread/realtime/appendAudio": CodexSchema.V2ThreadRealtimeAppendAudioParams;
  readonly "thread/realtime/appendText": CodexSchema.V2ThreadRealtimeAppendTextParams;
  readonly "thread/realtime/appendSpeech": CodexSchema.V2ThreadRealtimeAppendSpeechParams;
  readonly "thread/realtime/stop": CodexSchema.V2ThreadRealtimeStopParams;
  readonly "thread/timeline/list": CodexSchema.V2ThreadTimelineListParams;
  readonly "thread/realtime/listVoices": CodexSchema.V2ThreadRealtimeListVoicesParams;
  readonly "review/start": CodexSchema.V2ReviewStartParams;
  readonly "model/list": CodexSchema.V2ModelListParams;
  readonly "modelProvider/capabilities/read": CodexSchema.V2ModelProviderCapabilitiesReadParams;
  readonly "experimentalFeature/list": CodexSchema.V2ExperimentalFeatureListParams;
  readonly "permissionProfile/list": CodexSchema.V2PermissionProfileListParams;
  readonly "experimentalFeature/enablement/set": CodexSchema.V2ExperimentalFeatureEnablementSetParams;
  readonly "remoteControl/enable": CodexSchema.V2NullableRemoteControlEnableParams__RemoteControlEnableParams | null;
  readonly "remoteControl/disable": CodexSchema.V2NullableRemoteControlDisableParams__RemoteControlDisableParams | null;
  readonly "remoteControl/status/read": undefined;
  readonly "remoteControl/pairing/start": CodexSchema.V2RemoteControlPairingStartParams;
  readonly "remoteControl/pairing/status": CodexSchema.V2RemoteControlPairingStatusParams;
  readonly "remoteControl/client/list": CodexSchema.V2RemoteControlClientsListParams;
  readonly "remoteControl/client/revoke": CodexSchema.V2RemoteControlClientsRevokeParams;
  readonly "collaborationMode/list": CodexSchema.V2CollaborationModeListParams;
  readonly "mock/experimentalMethod": CodexSchema.V2MockExperimentalMethodParams;
  readonly "environment/add": CodexSchema.V2EnvironmentAddParams;
  readonly "environment/info": CodexSchema.V2EnvironmentInfoParams;
  readonly "environment/status": CodexSchema.V2EnvironmentStatusParams;
  readonly "mcpServer/oauth/login": CodexSchema.V2McpServerOauthLoginParams;
  readonly "config/mcpServer/reload": undefined;
  readonly "mcpServerStatus/list": CodexSchema.V2ListMcpServerStatusParams;
  readonly "mcpServer/resource/read": CodexSchema.V2McpResourceReadParams;
  readonly "mcpServer/event/stream/start": CodexSchema.V2McpServerEventStreamStartParams;
  readonly "mcpServer/event/stream/stop": CodexSchema.V2McpServerEventStreamStopParams;
  readonly "mcpServer/tool/call": CodexSchema.V2McpServerToolCallParams;
  readonly "windowsSandbox/setupStart": CodexSchema.V2WindowsSandboxSetupStartParams;
  readonly "windowsSandbox/readiness": undefined;
  readonly "account/login/start": CodexSchema.V2LoginAccountParams;
  readonly "account/bedrock/discover": CodexSchema.V2BedrockDiscoverParams;
  readonly "account/bedrock/setup": CodexSchema.V2BedrockSetupParams;
  readonly "account/login/cancel": CodexSchema.V2CancelLoginAccountParams;
  readonly "account/logout": undefined;
  readonly "account/rateLimits/read": undefined;
  readonly "account/rateLimitResetCredit/consume": CodexSchema.V2ConsumeAccountRateLimitResetCreditParams;
  readonly "account/usage/read":
    | CodexSchema.V2NullableGetAccountTokenUsageParams__GetAccountTokenUsageParams
    | undefined;
  readonly "account/workspaceMessages/read": undefined;
  readonly "account/sendAddCreditsNudgeEmail": CodexSchema.V2SendAddCreditsNudgeEmailParams;
  readonly "feedback/upload": CodexSchema.V2FeedbackUploadParams;
  readonly "command/exec": CodexSchema.V2CommandExecParams;
  readonly "command/exec/write": CodexSchema.V2CommandExecWriteParams;
  readonly "command/exec/terminate": CodexSchema.V2CommandExecTerminateParams;
  readonly "command/exec/resize": CodexSchema.V2CommandExecResizeParams;
  readonly "process/spawn": CodexSchema.V2ProcessSpawnParams;
  readonly "process/writeStdin": CodexSchema.V2ProcessWriteStdinParams;
  readonly "process/kill": CodexSchema.V2ProcessKillParams;
  readonly "process/resizePty": CodexSchema.V2ProcessResizePtyParams;
  readonly "config/read": CodexSchema.V2ConfigReadParams;
  readonly "externalAgentConfig/detect": CodexSchema.V2ExternalAgentConfigDetectParams;
  readonly "externalAgentConfig/import": CodexSchema.V2ExternalAgentConfigImportParams;
  readonly "externalAgentConfig/import/recordHistory": CodexSchema.V2ExternalAgentConfigImportHistoryRecordParams;
  readonly "externalAgentConfig/import/readHistories": undefined;
  readonly "config/value/write": CodexSchema.V2ConfigValueWriteParams;
  readonly "config/batchWrite": CodexSchema.V2ConfigBatchWriteParams;
  readonly "configRequirements/read": undefined;
  readonly "account/read": CodexSchema.V2GetAccountParams;
  readonly getConversationSummary: CodexSchema.GetConversationSummaryParams;
  readonly gitDiffToRemote: CodexSchema.GitDiffToRemoteParams;
  readonly getAuthStatus: CodexSchema.GetAuthStatusParams;
  readonly fuzzyFileSearch: CodexSchema.FuzzyFileSearchParams;
  readonly "fuzzyFileSearch/sessionStart": CodexSchema.FuzzyFileSearchSessionStartParams;
  readonly "fuzzyFileSearch/sessionUpdate": CodexSchema.FuzzyFileSearchSessionUpdateParams;
  readonly "fuzzyFileSearch/sessionStop": CodexSchema.FuzzyFileSearchSessionStopParams;
}

export interface ClientRequestResponsesByMethod {
  readonly initialize: CodexSchema.V1InitializeResponse;
  readonly "server/diagnostics": CodexSchema.V2ServerDiagnosticsResponse;
  readonly "thread/start": CodexSchema.V2ThreadStartResponse;
  readonly "thread/resume": CodexSchema.V2ThreadResumeResponse;
  readonly "thread/fork": CodexSchema.V2ThreadForkResponse;
  readonly "thread/archive": CodexSchema.V2ThreadArchiveResponse;
  readonly "thread/delete": CodexSchema.V2ThreadDeleteResponse;
  readonly "thread/unsubscribe": CodexSchema.V2ThreadUnsubscribeResponse;
  readonly "thread/increment_elicitation": CodexSchema.V2ThreadIncrementElicitationResponse;
  readonly "thread/decrement_elicitation": CodexSchema.V2ThreadDecrementElicitationResponse;
  readonly "thread/name/set": CodexSchema.V2ThreadSetNameResponse;
  readonly "thread/goal/set": CodexSchema.V2ThreadGoalSetResponse;
  readonly "thread/goal/get": CodexSchema.V2ThreadGoalGetResponse;
  readonly "thread/goal/clear": CodexSchema.V2ThreadGoalClearResponse;
  readonly "thread/queue/add": CodexSchema.V2ThreadQueueAddResponse;
  readonly "thread/queue/list": CodexSchema.V2ThreadQueueListResponse;
  readonly "thread/queue/update": CodexSchema.V2ThreadQueueUpdateResponse;
  readonly "thread/queue/delete": CodexSchema.V2ThreadQueueDeleteResponse;
  readonly "thread/queue/reorder": CodexSchema.V2ThreadQueueReorderResponse;
  readonly "thread/queue/start": CodexSchema.V2ThreadQueueStartResponse;
  readonly "thread/metadata/update": CodexSchema.V2ThreadMetadataUpdateResponse;
  readonly "thread/section/move": CodexSchema.V2ThreadSectionMoveResponse;
  readonly "thread/settings/update": CodexSchema.V2ThreadSettingsUpdateResponse;
  readonly "thread/memoryMode/set": CodexSchema.V2ThreadMemoryModeSetResponse;
  readonly "memory/reset": CodexSchema.V2MemoryResetResponse;
  readonly "thread/unarchive": CodexSchema.V2ThreadUnarchiveResponse;
  readonly "thread/compact/start": CodexSchema.V2ThreadCompactStartResponse;
  readonly "thread/shellCommand": CodexSchema.V2ThreadShellCommandResponse;
  readonly "thread/approveGuardianDeniedAction": CodexSchema.V2ThreadApproveGuardianDeniedActionResponse;
  readonly "thread/backgroundTerminals/clean": CodexSchema.V2ThreadBackgroundTerminalsCleanResponse;
  readonly "thread/backgroundTerminals/list": CodexSchema.V2ThreadBackgroundTerminalsListResponse;
  readonly "thread/backgroundTerminals/terminate": CodexSchema.V2ThreadBackgroundTerminalsTerminateResponse;
  readonly "thread/rollback": CodexSchema.V2ThreadRollbackResponse;
  readonly "thread/revert": CodexSchema.V2ThreadRevertResponse;
  readonly "thread/list": CodexSchema.V2ThreadListResponse;
  readonly "project/list": CodexSchema.V2ProjectListResponse;
  readonly "project/read": CodexSchema.V2ProjectReadResponse;
  readonly "project/create": CodexSchema.V2ProjectCreateResponse;
  readonly "project/import": CodexSchema.V2ProjectImportResponse;
  readonly "project/update": CodexSchema.V2ProjectUpdateResponse;
  readonly "project/move": CodexSchema.V2ProjectMoveResponse;
  readonly "project/delete": CodexSchema.V2ProjectDeleteResponse;
  readonly "threadSection/list": CodexSchema.V2ThreadSectionListResponse;
  readonly "threadSection/create": CodexSchema.V2ThreadSectionCreateResponse;
  readonly "threadSection/update": CodexSchema.V2ThreadSectionUpdateResponse;
  readonly "threadSection/delete": CodexSchema.V2ThreadSectionDeleteResponse;
  readonly "thread/search": CodexSchema.V2ThreadSearchResponse;
  readonly "thread/searchOccurrences": CodexSchema.V2ThreadSearchOccurrencesResponse;
  readonly "thread/loaded/list": CodexSchema.V2ThreadLoadedListResponse;
  readonly "thread/read": CodexSchema.V2ThreadReadResponse;
  readonly "thread/turns/list": CodexSchema.V2ThreadTurnsListResponse;
  readonly "thread/items/list": CodexSchema.V2ThreadItemsListResponse;
  readonly "thread/inject_items": CodexSchema.V2ThreadInjectItemsResponse;
  readonly "skills/list": CodexSchema.V2SkillsListResponse;
  readonly "skills/extraRoots/set": CodexSchema.V2SkillsExtraRootsSetResponse;
  readonly "hooks/list": CodexSchema.V2HooksListResponse;
  readonly "marketplace/add": CodexSchema.V2MarketplaceAddResponse;
  readonly "marketplace/remove": CodexSchema.V2MarketplaceRemoveResponse;
  readonly "marketplace/upgrade": CodexSchema.V2MarketplaceUpgradeResponse;
  readonly "plugin/list": CodexSchema.V2PluginListResponse;
  readonly "plugin/search": CodexSchema.V2PluginSearchResponse;
  readonly "plugin/installed": CodexSchema.V2PluginInstalledResponse;
  readonly "plugin/read": CodexSchema.V2PluginReadResponse;
  readonly "plugin/skill/read": CodexSchema.V2PluginSkillReadResponse;
  readonly "plugin/share/save": CodexSchema.V2PluginShareSaveResponse;
  readonly "plugin/share/updateTargets": CodexSchema.V2PluginShareUpdateTargetsResponse;
  readonly "plugin/share/list": CodexSchema.V2PluginShareListResponse;
  readonly "plugin/share/checkout": CodexSchema.V2PluginShareCheckoutResponse;
  readonly "plugin/share/delete": CodexSchema.V2PluginShareDeleteResponse;
  readonly "app/read": CodexSchema.V2AppsReadResponse;
  readonly "app/list": CodexSchema.V2AppsListResponse;
  readonly "app/installed": CodexSchema.V2AppsInstalledResponse;
  readonly "fs/readFile": CodexSchema.V2FsReadFileResponse;
  readonly "fs/writeFile": CodexSchema.V2FsWriteFileResponse;
  readonly "fs/createDirectory": CodexSchema.V2FsCreateDirectoryResponse;
  readonly "fs/getMetadata": CodexSchema.V2FsGetMetadataResponse;
  readonly "fs/readDirectory": CodexSchema.V2FsReadDirectoryResponse;
  readonly "fs/remove": CodexSchema.V2FsRemoveResponse;
  readonly "fs/copy": CodexSchema.V2FsCopyResponse;
  readonly "fs/watch": CodexSchema.V2FsWatchResponse;
  readonly "fs/unwatch": CodexSchema.V2FsUnwatchResponse;
  readonly "skills/config/write": CodexSchema.V2SkillsConfigWriteResponse;
  readonly "plugin/install": CodexSchema.V2PluginInstallResponse;
  readonly "plugin/uninstall": CodexSchema.V2PluginUninstallResponse;
  readonly "turn/start": CodexSchema.V2TurnStartResponse;
  readonly "turn/settings/update": CodexSchema.V2TurnSettingsUpdateResponse;
  readonly "turn/steer": CodexSchema.V2TurnSteerResponse;
  readonly "turn/interrupt": CodexSchema.V2TurnInterruptResponse;
  readonly "thread/realtime/start": CodexSchema.V2ThreadRealtimeStartResponse;
  readonly "thread/realtime/appendAudio": CodexSchema.V2ThreadRealtimeAppendAudioResponse;
  readonly "thread/realtime/appendText": CodexSchema.V2ThreadRealtimeAppendTextResponse;
  readonly "thread/realtime/appendSpeech": CodexSchema.V2ThreadRealtimeAppendSpeechResponse;
  readonly "thread/realtime/stop": CodexSchema.V2ThreadRealtimeStopResponse;
  readonly "thread/timeline/list": CodexSchema.V2ThreadTimelineListResponse;
  readonly "thread/realtime/listVoices": CodexSchema.V2ThreadRealtimeListVoicesResponse;
  readonly "review/start": CodexSchema.V2ReviewStartResponse;
  readonly "model/list": CodexSchema.V2ModelListResponse;
  readonly "modelProvider/capabilities/read": CodexSchema.V2ModelProviderCapabilitiesReadResponse;
  readonly "experimentalFeature/list": CodexSchema.V2ExperimentalFeatureListResponse;
  readonly "permissionProfile/list": CodexSchema.V2PermissionProfileListResponse;
  readonly "experimentalFeature/enablement/set": CodexSchema.V2ExperimentalFeatureEnablementSetResponse;
  readonly "remoteControl/enable": CodexSchema.V2RemoteControlEnableResponse;
  readonly "remoteControl/disable": CodexSchema.V2RemoteControlDisableResponse;
  readonly "remoteControl/status/read": CodexSchema.V2RemoteControlStatusReadResponse;
  readonly "remoteControl/pairing/start": CodexSchema.V2RemoteControlPairingStartResponse;
  readonly "remoteControl/pairing/status": CodexSchema.V2RemoteControlPairingStatusResponse;
  readonly "remoteControl/client/list": CodexSchema.V2RemoteControlClientsListResponse;
  readonly "remoteControl/client/revoke": CodexSchema.V2RemoteControlClientsRevokeResponse;
  readonly "collaborationMode/list": CodexSchema.V2CollaborationModeListResponse;
  readonly "mock/experimentalMethod": CodexSchema.V2MockExperimentalMethodResponse;
  readonly "environment/add": CodexSchema.V2EnvironmentAddResponse;
  readonly "environment/info": CodexSchema.V2EnvironmentInfoResponse;
  readonly "environment/status": CodexSchema.V2EnvironmentStatusResponse;
  readonly "mcpServer/oauth/login": CodexSchema.V2McpServerOauthLoginResponse;
  readonly "config/mcpServer/reload": CodexSchema.V2McpServerRefreshResponse;
  readonly "mcpServerStatus/list": CodexSchema.V2ListMcpServerStatusResponse;
  readonly "mcpServer/resource/read": CodexSchema.V2McpResourceReadResponse;
  readonly "mcpServer/event/stream/start": CodexSchema.V2McpServerEventStreamStartResponse;
  readonly "mcpServer/event/stream/stop": CodexSchema.V2McpServerEventStreamStopResponse;
  readonly "mcpServer/tool/call": CodexSchema.V2McpServerToolCallResponse;
  readonly "windowsSandbox/setupStart": CodexSchema.V2WindowsSandboxSetupStartResponse;
  readonly "windowsSandbox/readiness": CodexSchema.V2WindowsSandboxReadinessResponse;
  readonly "account/login/start": CodexSchema.V2LoginAccountResponse;
  readonly "account/bedrock/discover": CodexSchema.V2BedrockDiscoverResponse;
  readonly "account/bedrock/setup": CodexSchema.V2BedrockSetupResponse;
  readonly "account/login/cancel": CodexSchema.V2CancelLoginAccountResponse;
  readonly "account/logout": CodexSchema.V2LogoutAccountResponse;
  readonly "account/rateLimits/read": CodexSchema.V2GetAccountRateLimitsResponse;
  readonly "account/rateLimitResetCredit/consume": CodexSchema.V2ConsumeAccountRateLimitResetCreditResponse;
  readonly "account/usage/read": CodexSchema.V2GetAccountTokenUsageResponse;
  readonly "account/workspaceMessages/read": CodexSchema.V2GetWorkspaceMessagesResponse;
  readonly "account/sendAddCreditsNudgeEmail": CodexSchema.V2SendAddCreditsNudgeEmailResponse;
  readonly "feedback/upload": CodexSchema.V2FeedbackUploadResponse;
  readonly "command/exec": CodexSchema.V2CommandExecResponse;
  readonly "command/exec/write": CodexSchema.V2CommandExecWriteResponse;
  readonly "command/exec/terminate": CodexSchema.V2CommandExecTerminateResponse;
  readonly "command/exec/resize": CodexSchema.V2CommandExecResizeResponse;
  readonly "process/spawn": CodexSchema.V2ProcessSpawnResponse;
  readonly "process/writeStdin": CodexSchema.V2ProcessWriteStdinResponse;
  readonly "process/kill": CodexSchema.V2ProcessKillResponse;
  readonly "process/resizePty": CodexSchema.V2ProcessResizePtyResponse;
  readonly "config/read": CodexSchema.V2ConfigReadResponse;
  readonly "externalAgentConfig/detect": CodexSchema.V2ExternalAgentConfigDetectResponse;
  readonly "externalAgentConfig/import": CodexSchema.V2ExternalAgentConfigImportResponse;
  readonly "externalAgentConfig/import/recordHistory": CodexSchema.V2ExternalAgentConfigImportHistoryRecordResponse;
  readonly "externalAgentConfig/import/readHistories": CodexSchema.V2ExternalAgentConfigImportHistoriesReadResponse;
  readonly "config/value/write": CodexSchema.V2ConfigWriteResponse;
  readonly "config/batchWrite": CodexSchema.V2ConfigWriteResponse;
  readonly "configRequirements/read": CodexSchema.V2ConfigRequirementsReadResponse;
  readonly "account/read": CodexSchema.V2GetAccountResponse;
  readonly getConversationSummary: CodexSchema.GetConversationSummaryResponse;
  readonly gitDiffToRemote: CodexSchema.GitDiffToRemoteResponse;
  readonly getAuthStatus: CodexSchema.GetAuthStatusResponse;
  readonly fuzzyFileSearch: CodexSchema.FuzzyFileSearchResponse;
  readonly "fuzzyFileSearch/sessionStart": CodexSchema.FuzzyFileSearchSessionStartResponse;
  readonly "fuzzyFileSearch/sessionUpdate": CodexSchema.FuzzyFileSearchSessionUpdateResponse;
  readonly "fuzzyFileSearch/sessionStop": CodexSchema.FuzzyFileSearchSessionStopResponse;
}

export interface ClientNotificationParamsByMethod {
  readonly initialized: undefined;
}

export interface ServerRequestParamsByMethod {
  readonly "item/commandExecution/requestApproval": CodexSchema.CommandExecutionRequestApprovalParams;
  readonly "item/fileChange/requestApproval": CodexSchema.FileChangeRequestApprovalParams;
  readonly "item/tool/requestUserInput": CodexSchema.ToolRequestUserInputParams;
  readonly "mcpServer/elicitation/request": CodexSchema.McpServerElicitationRequestParams;
  readonly "item/permissions/requestApproval": CodexSchema.PermissionsRequestApprovalParams;
  readonly "item/tool/call": CodexSchema.DynamicToolCallParams;
  readonly "account/chatgptAuthTokens/refresh": CodexSchema.ChatgptAuthTokensRefreshParams;
  readonly "attestation/generate": CodexSchema.AttestationGenerateParams;
  readonly "currentTime/read": CodexSchema.CurrentTimeReadParams;
  readonly applyPatchApproval: CodexSchema.ApplyPatchApprovalParams;
  readonly execCommandApproval: CodexSchema.ExecCommandApprovalParams;
}

export interface ServerRequestResponsesByMethod {
  readonly "item/commandExecution/requestApproval": CodexSchema.CommandExecutionRequestApprovalResponse;
  readonly "item/fileChange/requestApproval": CodexSchema.FileChangeRequestApprovalResponse;
  readonly "item/tool/requestUserInput": CodexSchema.ToolRequestUserInputResponse;
  readonly "mcpServer/elicitation/request": CodexSchema.McpServerElicitationRequestResponse;
  readonly "item/permissions/requestApproval": CodexSchema.PermissionsRequestApprovalResponse;
  readonly "item/tool/call": CodexSchema.DynamicToolCallResponse;
  readonly "account/chatgptAuthTokens/refresh": CodexSchema.ChatgptAuthTokensRefreshResponse;
  readonly "attestation/generate": CodexSchema.AttestationGenerateResponse;
  readonly "currentTime/read": CodexSchema.CurrentTimeReadResponse;
  readonly applyPatchApproval: CodexSchema.ApplyPatchApprovalResponse;
  readonly execCommandApproval: CodexSchema.ExecCommandApprovalResponse;
}

export interface ServerNotificationParamsByMethod {
  readonly error: CodexSchema.V2ErrorNotification;
  readonly "thread/started": CodexSchema.V2ThreadStartedNotification;
  readonly "thread/status/changed": CodexSchema.V2ThreadStatusChangedNotification;
  readonly "thread/archived": CodexSchema.V2ThreadArchivedNotification;
  readonly "thread/deleted": CodexSchema.V2ThreadDeletedNotification;
  readonly "thread/unarchived": CodexSchema.V2ThreadUnarchivedNotification;
  readonly "thread/closed": CodexSchema.V2ThreadClosedNotification;
  readonly "thread/reverted": CodexSchema.V2ThreadRevertedNotification;
  readonly "skills/changed": CodexSchema.V2SkillsChangedNotification;
  readonly "thread/name/updated": CodexSchema.V2ThreadNameUpdatedNotification;
  readonly "thread/goal/updated": CodexSchema.V2ThreadGoalUpdatedNotification;
  readonly "thread/goal/cleared": CodexSchema.V2ThreadGoalClearedNotification;
  readonly "thread/queue/changed": CodexSchema.V2ThreadQueueChangedNotification;
  readonly "project/changed": CodexSchema.V2ProjectChangedNotification;
  readonly "thread/project/updated": CodexSchema.V2ThreadProjectUpdatedNotification;
  readonly "thread/environment/connected": CodexSchema.V2EnvironmentConnectionNotification;
  readonly "thread/environment/disconnected": CodexSchema.V2EnvironmentConnectionNotification;
  readonly "thread/settings/updated": CodexSchema.V2ThreadSettingsUpdatedNotification;
  readonly "thread/tokenUsage/updated": CodexSchema.V2ThreadTokenUsageUpdatedNotification;
  readonly "turn/started": CodexSchema.V2TurnStartedNotification;
  readonly "hook/started": CodexSchema.V2HookStartedNotification;
  readonly "turn/completed": CodexSchema.V2TurnCompletedNotification;
  readonly "hook/completed": CodexSchema.V2HookCompletedNotification;
  readonly "turn/diff/updated": CodexSchema.V2TurnDiffUpdatedNotification;
  readonly "turn/plan/updated": CodexSchema.V2TurnPlanUpdatedNotification;
  readonly "item/started": CodexSchema.V2ItemStartedNotification;
  readonly "item/autoApprovalReview/started": CodexSchema.V2ItemGuardianApprovalReviewStartedNotification;
  readonly "item/autoApprovalReview/completed": CodexSchema.V2ItemGuardianApprovalReviewCompletedNotification;
  readonly "autoApprovalReview/strictReviewRequired": CodexSchema.V2StrictReviewRequiredNotification;
  readonly "item/completed": CodexSchema.V2ItemCompletedNotification;
  readonly "rawResponseItem/completed": CodexSchema.V2RawResponseItemCompletedNotification;
  readonly "rawResponse/completed": CodexSchema.V2RawResponseCompletedNotification;
  readonly "item/agentMessage/delta": CodexSchema.V2AgentMessageDeltaNotification;
  readonly "item/plan/delta": CodexSchema.V2PlanDeltaNotification;
  readonly "command/exec/outputDelta": CodexSchema.V2CommandExecOutputDeltaNotification;
  readonly "process/outputDelta": CodexSchema.V2ProcessOutputDeltaNotification;
  readonly "process/exited": CodexSchema.V2ProcessExitedNotification;
  readonly "item/commandExecution/outputDelta": CodexSchema.V2CommandExecutionOutputDeltaNotification;
  readonly "item/commandExecution/terminalInteraction": CodexSchema.V2TerminalInteractionNotification;
  readonly "item/fileChange/outputDelta": CodexSchema.V2FileChangeOutputDeltaNotification;
  readonly "item/fileChange/patchUpdated": CodexSchema.V2FileChangePatchUpdatedNotification;
  readonly "serverRequest/resolved": CodexSchema.V2ServerRequestResolvedNotification;
  readonly "item/mcpToolCall/progress": CodexSchema.V2McpToolCallProgressNotification;
  readonly "mcpServer/oauthLogin/completed": CodexSchema.V2McpServerOauthLoginCompletedNotification;
  readonly "mcpServer/startupStatus/updated": CodexSchema.V2McpServerStatusUpdatedNotification;
  readonly "mcpServer/event/stream/notification": CodexSchema.V2McpServerEventStreamNotification;
  readonly "account/updated": CodexSchema.V2AccountUpdatedNotification;
  readonly "account/rateLimits/updated": CodexSchema.V2AccountRateLimitsUpdatedNotification;
  readonly "app/list/updated": CodexSchema.V2AppListUpdatedNotification;
  readonly "remoteControl/status/changed": CodexSchema.V2RemoteControlStatusChangedNotification;
  readonly "externalAgentConfig/import/progress": CodexSchema.V2ExternalAgentConfigImportProgressNotification;
  readonly "externalAgentConfig/import/completed": CodexSchema.V2ExternalAgentConfigImportCompletedNotification;
  readonly "fs/changed": CodexSchema.V2FsChangedNotification;
  readonly "item/reasoning/summaryTextDelta": CodexSchema.V2ReasoningSummaryTextDeltaNotification;
  readonly "item/reasoning/summaryPartAdded": CodexSchema.V2ReasoningSummaryPartAddedNotification;
  readonly "item/reasoning/textDelta": CodexSchema.V2ReasoningTextDeltaNotification;
  readonly "thread/compacted": CodexSchema.V2ContextCompactedNotification;
  readonly "model/rerouted": CodexSchema.V2ModelReroutedNotification;
  readonly "model/verification": CodexSchema.V2ModelVerificationNotification;
  readonly "modelProvider/authRecoveryStarted": CodexSchema.V2AuthRecoveryNotification;
  readonly "modelProvider/authRecoveryCompleted": CodexSchema.V2AuthRecoveryNotification;
  readonly "turn/moderationMetadata": CodexSchema.V2TurnModerationMetadataNotification;
  readonly "model/safetyBuffering/updated": CodexSchema.V2ModelSafetyBufferingUpdatedNotification;
  readonly warning: CodexSchema.V2WarningNotification;
  readonly guardianWarning: CodexSchema.V2GuardianWarningNotification;
  readonly deprecationNotice: CodexSchema.V2DeprecationNoticeNotification;
  readonly configWarning: CodexSchema.V2ConfigWarningNotification;
  readonly "fuzzyFileSearch/sessionUpdated": CodexSchema.FuzzyFileSearchSessionUpdatedNotification;
  readonly "fuzzyFileSearch/sessionCompleted": CodexSchema.FuzzyFileSearchSessionCompletedNotification;
  readonly "thread/realtime/started": CodexSchema.V2ThreadRealtimeStartedNotification;
  readonly "thread/realtime/itemAdded": CodexSchema.V2ThreadRealtimeItemAddedNotification;
  readonly "thread/realtime/item/started": CodexSchema.V2ThreadRealtimeItemStartedNotification;
  readonly "thread/realtime/item/transcript/delta": CodexSchema.V2ThreadRealtimeItemTranscriptDeltaNotification;
  readonly "thread/realtime/item/completed": CodexSchema.V2ThreadRealtimeItemCompletedNotification;
  readonly "thread/realtime/transcript/delta": CodexSchema.V2ThreadRealtimeTranscriptDeltaNotification;
  readonly "thread/realtime/transcript/done": CodexSchema.V2ThreadRealtimeTranscriptDoneNotification;
  readonly "thread/realtime/outputAudio/delta": CodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification;
  readonly "thread/realtime/sdp": CodexSchema.V2ThreadRealtimeSdpNotification;
  readonly "thread/realtime/error": CodexSchema.V2ThreadRealtimeErrorNotification;
  readonly "thread/realtime/closed": CodexSchema.V2ThreadRealtimeClosedNotification;
  readonly "windows/worldWritableWarning": CodexSchema.V2WindowsWorldWritableWarningNotification;
  readonly "windowsSandbox/setupCompleted": CodexSchema.V2WindowsSandboxSetupCompletedNotification;
  readonly "account/login/completed": CodexSchema.V2AccountLoginCompletedNotification;
}

export const CLIENT_REQUEST_PARAMS = {
  initialize: CodexSchema.V1InitializeParams,
  "server/diagnostics": CodexSchema.V2ServerDiagnosticsParams,
  "thread/start": CodexSchema.V2ThreadStartParams,
  "thread/resume": CodexSchema.V2ThreadResumeParams,
  "thread/fork": CodexSchema.V2ThreadForkParams,
  "thread/archive": CodexSchema.V2ThreadArchiveParams,
  "thread/delete": CodexSchema.V2ThreadDeleteParams,
  "thread/unsubscribe": CodexSchema.V2ThreadUnsubscribeParams,
  "thread/increment_elicitation": CodexSchema.V2ThreadIncrementElicitationParams,
  "thread/decrement_elicitation": CodexSchema.V2ThreadDecrementElicitationParams,
  "thread/name/set": CodexSchema.V2ThreadSetNameParams,
  "thread/goal/set": CodexSchema.V2ThreadGoalSetParams,
  "thread/goal/get": CodexSchema.V2ThreadGoalGetParams,
  "thread/goal/clear": CodexSchema.V2ThreadGoalClearParams,
  "thread/queue/add": CodexSchema.V2ThreadQueueAddParams,
  "thread/queue/list": CodexSchema.V2ThreadQueueListParams,
  "thread/queue/update": CodexSchema.V2ThreadQueueUpdateParams,
  "thread/queue/delete": CodexSchema.V2ThreadQueueDeleteParams,
  "thread/queue/reorder": CodexSchema.V2ThreadQueueReorderParams,
  "thread/queue/start": CodexSchema.V2ThreadQueueStartParams,
  "thread/metadata/update": CodexSchema.V2ThreadMetadataUpdateParams,
  "thread/section/move": CodexSchema.V2ThreadSectionMoveParams,
  "thread/settings/update": CodexSchema.V2ThreadSettingsUpdateParams,
  "thread/memoryMode/set": CodexSchema.V2ThreadMemoryModeSetParams,
  "memory/reset": undefined,
  "thread/unarchive": CodexSchema.V2ThreadUnarchiveParams,
  "thread/compact/start": CodexSchema.V2ThreadCompactStartParams,
  "thread/shellCommand": CodexSchema.V2ThreadShellCommandParams,
  "thread/approveGuardianDeniedAction": CodexSchema.V2ThreadApproveGuardianDeniedActionParams,
  "thread/backgroundTerminals/clean": CodexSchema.V2ThreadBackgroundTerminalsCleanParams,
  "thread/backgroundTerminals/list": CodexSchema.V2ThreadBackgroundTerminalsListParams,
  "thread/backgroundTerminals/terminate": CodexSchema.V2ThreadBackgroundTerminalsTerminateParams,
  "thread/rollback": CodexSchema.V2ThreadRollbackParams,
  "thread/revert": CodexSchema.V2ThreadRevertParams,
  "thread/list": CodexSchema.V2ThreadListParams,
  "project/list": CodexSchema.V2ProjectListParams,
  "project/read": CodexSchema.V2ProjectReadParams,
  "project/create": CodexSchema.V2ProjectCreateParams,
  "project/import": CodexSchema.V2ProjectImportParams,
  "project/update": CodexSchema.V2ProjectUpdateParams,
  "project/move": CodexSchema.V2ProjectMoveParams,
  "project/delete": CodexSchema.V2ProjectDeleteParams,
  "threadSection/list": CodexSchema.V2ThreadSectionListParams,
  "threadSection/create": CodexSchema.V2ThreadSectionCreateParams,
  "threadSection/update": CodexSchema.V2ThreadSectionUpdateParams,
  "threadSection/delete": CodexSchema.V2ThreadSectionDeleteParams,
  "thread/search": CodexSchema.V2ThreadSearchParams,
  "thread/searchOccurrences": CodexSchema.V2ThreadSearchOccurrencesParams,
  "thread/loaded/list": CodexSchema.V2ThreadLoadedListParams,
  "thread/read": CodexSchema.V2ThreadReadParams,
  "thread/turns/list": CodexSchema.V2ThreadTurnsListParams,
  "thread/items/list": CodexSchema.V2ThreadItemsListParams,
  "thread/inject_items": CodexSchema.V2ThreadInjectItemsParams,
  "skills/list": CodexSchema.V2SkillsListParams,
  "skills/extraRoots/set": CodexSchema.V2SkillsExtraRootsSetParams,
  "hooks/list": CodexSchema.V2HooksListParams,
  "marketplace/add": CodexSchema.V2MarketplaceAddParams,
  "marketplace/remove": CodexSchema.V2MarketplaceRemoveParams,
  "marketplace/upgrade": CodexSchema.V2MarketplaceUpgradeParams,
  "plugin/list": CodexSchema.V2PluginListParams,
  "plugin/search": CodexSchema.V2PluginSearchParams,
  "plugin/installed": CodexSchema.V2PluginInstalledParams,
  "plugin/read": CodexSchema.V2PluginReadParams,
  "plugin/skill/read": CodexSchema.V2PluginSkillReadParams,
  "plugin/share/save": CodexSchema.V2PluginShareSaveParams,
  "plugin/share/updateTargets": CodexSchema.V2PluginShareUpdateTargetsParams,
  "plugin/share/list": CodexSchema.V2PluginShareListParams,
  "plugin/share/checkout": CodexSchema.V2PluginShareCheckoutParams,
  "plugin/share/delete": CodexSchema.V2PluginShareDeleteParams,
  "app/read": CodexSchema.V2AppsReadParams,
  "app/list": CodexSchema.V2AppsListParams,
  "app/installed": CodexSchema.V2AppsInstalledParams,
  "fs/readFile": CodexSchema.V2FsReadFileParams,
  "fs/writeFile": CodexSchema.V2FsWriteFileParams,
  "fs/createDirectory": CodexSchema.V2FsCreateDirectoryParams,
  "fs/getMetadata": CodexSchema.V2FsGetMetadataParams,
  "fs/readDirectory": CodexSchema.V2FsReadDirectoryParams,
  "fs/remove": CodexSchema.V2FsRemoveParams,
  "fs/copy": CodexSchema.V2FsCopyParams,
  "fs/watch": CodexSchema.V2FsWatchParams,
  "fs/unwatch": CodexSchema.V2FsUnwatchParams,
  "skills/config/write": CodexSchema.V2SkillsConfigWriteParams,
  "plugin/install": CodexSchema.V2PluginInstallParams,
  "plugin/uninstall": CodexSchema.V2PluginUninstallParams,
  "turn/start": CodexSchema.V2TurnStartParams,
  "turn/settings/update": CodexSchema.V2TurnSettingsUpdateParams,
  "turn/steer": CodexSchema.V2TurnSteerParams,
  "turn/interrupt": CodexSchema.V2TurnInterruptParams,
  "thread/realtime/start": CodexSchema.V2ThreadRealtimeStartParams,
  "thread/realtime/appendAudio": CodexSchema.V2ThreadRealtimeAppendAudioParams,
  "thread/realtime/appendText": CodexSchema.V2ThreadRealtimeAppendTextParams,
  "thread/realtime/appendSpeech": CodexSchema.V2ThreadRealtimeAppendSpeechParams,
  "thread/realtime/stop": CodexSchema.V2ThreadRealtimeStopParams,
  "thread/timeline/list": CodexSchema.V2ThreadTimelineListParams,
  "thread/realtime/listVoices": CodexSchema.V2ThreadRealtimeListVoicesParams,
  "review/start": CodexSchema.V2ReviewStartParams,
  "model/list": CodexSchema.V2ModelListParams,
  "modelProvider/capabilities/read": CodexSchema.V2ModelProviderCapabilitiesReadParams,
  "experimentalFeature/list": CodexSchema.V2ExperimentalFeatureListParams,
  "permissionProfile/list": CodexSchema.V2PermissionProfileListParams,
  "experimentalFeature/enablement/set": CodexSchema.V2ExperimentalFeatureEnablementSetParams,
  "remoteControl/enable": Schema.NullOr(
    CodexSchema.V2NullableRemoteControlEnableParams__RemoteControlEnableParams,
  ),
  "remoteControl/disable": Schema.NullOr(
    CodexSchema.V2NullableRemoteControlDisableParams__RemoteControlDisableParams,
  ),
  "remoteControl/status/read": undefined,
  "remoteControl/pairing/start": CodexSchema.V2RemoteControlPairingStartParams,
  "remoteControl/pairing/status": CodexSchema.V2RemoteControlPairingStatusParams,
  "remoteControl/client/list": CodexSchema.V2RemoteControlClientsListParams,
  "remoteControl/client/revoke": CodexSchema.V2RemoteControlClientsRevokeParams,
  "collaborationMode/list": CodexSchema.V2CollaborationModeListParams,
  "mock/experimentalMethod": CodexSchema.V2MockExperimentalMethodParams,
  "environment/add": CodexSchema.V2EnvironmentAddParams,
  "environment/info": CodexSchema.V2EnvironmentInfoParams,
  "environment/status": CodexSchema.V2EnvironmentStatusParams,
  "mcpServer/oauth/login": CodexSchema.V2McpServerOauthLoginParams,
  "config/mcpServer/reload": undefined,
  "mcpServerStatus/list": CodexSchema.V2ListMcpServerStatusParams,
  "mcpServer/resource/read": CodexSchema.V2McpResourceReadParams,
  "mcpServer/event/stream/start": CodexSchema.V2McpServerEventStreamStartParams,
  "mcpServer/event/stream/stop": CodexSchema.V2McpServerEventStreamStopParams,
  "mcpServer/tool/call": CodexSchema.V2McpServerToolCallParams,
  "windowsSandbox/setupStart": CodexSchema.V2WindowsSandboxSetupStartParams,
  "windowsSandbox/readiness": undefined,
  "account/login/start": CodexSchema.V2LoginAccountParams,
  "account/bedrock/discover": CodexSchema.V2BedrockDiscoverParams,
  "account/bedrock/setup": CodexSchema.V2BedrockSetupParams,
  "account/login/cancel": CodexSchema.V2CancelLoginAccountParams,
  "account/logout": undefined,
  "account/rateLimits/read": undefined,
  "account/rateLimitResetCredit/consume": CodexSchema.V2ConsumeAccountRateLimitResetCreditParams,
  "account/usage/read": Schema.UndefinedOr(
    CodexSchema.V2NullableGetAccountTokenUsageParams__GetAccountTokenUsageParams,
  ),
  "account/workspaceMessages/read": undefined,
  "account/sendAddCreditsNudgeEmail": CodexSchema.V2SendAddCreditsNudgeEmailParams,
  "feedback/upload": CodexSchema.V2FeedbackUploadParams,
  "command/exec": CodexSchema.V2CommandExecParams,
  "command/exec/write": CodexSchema.V2CommandExecWriteParams,
  "command/exec/terminate": CodexSchema.V2CommandExecTerminateParams,
  "command/exec/resize": CodexSchema.V2CommandExecResizeParams,
  "process/spawn": CodexSchema.V2ProcessSpawnParams,
  "process/writeStdin": CodexSchema.V2ProcessWriteStdinParams,
  "process/kill": CodexSchema.V2ProcessKillParams,
  "process/resizePty": CodexSchema.V2ProcessResizePtyParams,
  "config/read": CodexSchema.V2ConfigReadParams,
  "externalAgentConfig/detect": CodexSchema.V2ExternalAgentConfigDetectParams,
  "externalAgentConfig/import": CodexSchema.V2ExternalAgentConfigImportParams,
  "externalAgentConfig/import/recordHistory":
    CodexSchema.V2ExternalAgentConfigImportHistoryRecordParams,
  "externalAgentConfig/import/readHistories": undefined,
  "config/value/write": CodexSchema.V2ConfigValueWriteParams,
  "config/batchWrite": CodexSchema.V2ConfigBatchWriteParams,
  "configRequirements/read": undefined,
  "account/read": CodexSchema.V2GetAccountParams,
  getConversationSummary: CodexSchema.GetConversationSummaryParams,
  gitDiffToRemote: CodexSchema.GitDiffToRemoteParams,
  getAuthStatus: CodexSchema.GetAuthStatusParams,
  fuzzyFileSearch: CodexSchema.FuzzyFileSearchParams,
  "fuzzyFileSearch/sessionStart": CodexSchema.FuzzyFileSearchSessionStartParams,
  "fuzzyFileSearch/sessionUpdate": CodexSchema.FuzzyFileSearchSessionUpdateParams,
  "fuzzyFileSearch/sessionStop": CodexSchema.FuzzyFileSearchSessionStopParams,
} as const;

export const CLIENT_REQUEST_RESPONSES = {
  initialize: CodexSchema.V1InitializeResponse,
  "server/diagnostics": CodexSchema.V2ServerDiagnosticsResponse,
  "thread/start": CodexSchema.V2ThreadStartResponse,
  "thread/resume": CodexSchema.V2ThreadResumeResponse,
  "thread/fork": CodexSchema.V2ThreadForkResponse,
  "thread/archive": CodexSchema.V2ThreadArchiveResponse,
  "thread/delete": CodexSchema.V2ThreadDeleteResponse,
  "thread/unsubscribe": CodexSchema.V2ThreadUnsubscribeResponse,
  "thread/increment_elicitation": CodexSchema.V2ThreadIncrementElicitationResponse,
  "thread/decrement_elicitation": CodexSchema.V2ThreadDecrementElicitationResponse,
  "thread/name/set": CodexSchema.V2ThreadSetNameResponse,
  "thread/goal/set": CodexSchema.V2ThreadGoalSetResponse,
  "thread/goal/get": CodexSchema.V2ThreadGoalGetResponse,
  "thread/goal/clear": CodexSchema.V2ThreadGoalClearResponse,
  "thread/queue/add": CodexSchema.V2ThreadQueueAddResponse,
  "thread/queue/list": CodexSchema.V2ThreadQueueListResponse,
  "thread/queue/update": CodexSchema.V2ThreadQueueUpdateResponse,
  "thread/queue/delete": CodexSchema.V2ThreadQueueDeleteResponse,
  "thread/queue/reorder": CodexSchema.V2ThreadQueueReorderResponse,
  "thread/queue/start": CodexSchema.V2ThreadQueueStartResponse,
  "thread/metadata/update": CodexSchema.V2ThreadMetadataUpdateResponse,
  "thread/section/move": CodexSchema.V2ThreadSectionMoveResponse,
  "thread/settings/update": CodexSchema.V2ThreadSettingsUpdateResponse,
  "thread/memoryMode/set": CodexSchema.V2ThreadMemoryModeSetResponse,
  "memory/reset": CodexSchema.V2MemoryResetResponse,
  "thread/unarchive": CodexSchema.V2ThreadUnarchiveResponse,
  "thread/compact/start": CodexSchema.V2ThreadCompactStartResponse,
  "thread/shellCommand": CodexSchema.V2ThreadShellCommandResponse,
  "thread/approveGuardianDeniedAction": CodexSchema.V2ThreadApproveGuardianDeniedActionResponse,
  "thread/backgroundTerminals/clean": CodexSchema.V2ThreadBackgroundTerminalsCleanResponse,
  "thread/backgroundTerminals/list": CodexSchema.V2ThreadBackgroundTerminalsListResponse,
  "thread/backgroundTerminals/terminate": CodexSchema.V2ThreadBackgroundTerminalsTerminateResponse,
  "thread/rollback": CodexSchema.V2ThreadRollbackResponse,
  "thread/revert": CodexSchema.V2ThreadRevertResponse,
  "thread/list": CodexSchema.V2ThreadListResponse,
  "project/list": CodexSchema.V2ProjectListResponse,
  "project/read": CodexSchema.V2ProjectReadResponse,
  "project/create": CodexSchema.V2ProjectCreateResponse,
  "project/import": CodexSchema.V2ProjectImportResponse,
  "project/update": CodexSchema.V2ProjectUpdateResponse,
  "project/move": CodexSchema.V2ProjectMoveResponse,
  "project/delete": CodexSchema.V2ProjectDeleteResponse,
  "threadSection/list": CodexSchema.V2ThreadSectionListResponse,
  "threadSection/create": CodexSchema.V2ThreadSectionCreateResponse,
  "threadSection/update": CodexSchema.V2ThreadSectionUpdateResponse,
  "threadSection/delete": CodexSchema.V2ThreadSectionDeleteResponse,
  "thread/search": CodexSchema.V2ThreadSearchResponse,
  "thread/searchOccurrences": CodexSchema.V2ThreadSearchOccurrencesResponse,
  "thread/loaded/list": CodexSchema.V2ThreadLoadedListResponse,
  "thread/read": CodexSchema.V2ThreadReadResponse,
  "thread/turns/list": CodexSchema.V2ThreadTurnsListResponse,
  "thread/items/list": CodexSchema.V2ThreadItemsListResponse,
  "thread/inject_items": CodexSchema.V2ThreadInjectItemsResponse,
  "skills/list": CodexSchema.V2SkillsListResponse,
  "skills/extraRoots/set": CodexSchema.V2SkillsExtraRootsSetResponse,
  "hooks/list": CodexSchema.V2HooksListResponse,
  "marketplace/add": CodexSchema.V2MarketplaceAddResponse,
  "marketplace/remove": CodexSchema.V2MarketplaceRemoveResponse,
  "marketplace/upgrade": CodexSchema.V2MarketplaceUpgradeResponse,
  "plugin/list": CodexSchema.V2PluginListResponse,
  "plugin/search": CodexSchema.V2PluginSearchResponse,
  "plugin/installed": CodexSchema.V2PluginInstalledResponse,
  "plugin/read": CodexSchema.V2PluginReadResponse,
  "plugin/skill/read": CodexSchema.V2PluginSkillReadResponse,
  "plugin/share/save": CodexSchema.V2PluginShareSaveResponse,
  "plugin/share/updateTargets": CodexSchema.V2PluginShareUpdateTargetsResponse,
  "plugin/share/list": CodexSchema.V2PluginShareListResponse,
  "plugin/share/checkout": CodexSchema.V2PluginShareCheckoutResponse,
  "plugin/share/delete": CodexSchema.V2PluginShareDeleteResponse,
  "app/read": CodexSchema.V2AppsReadResponse,
  "app/list": CodexSchema.V2AppsListResponse,
  "app/installed": CodexSchema.V2AppsInstalledResponse,
  "fs/readFile": CodexSchema.V2FsReadFileResponse,
  "fs/writeFile": CodexSchema.V2FsWriteFileResponse,
  "fs/createDirectory": CodexSchema.V2FsCreateDirectoryResponse,
  "fs/getMetadata": CodexSchema.V2FsGetMetadataResponse,
  "fs/readDirectory": CodexSchema.V2FsReadDirectoryResponse,
  "fs/remove": CodexSchema.V2FsRemoveResponse,
  "fs/copy": CodexSchema.V2FsCopyResponse,
  "fs/watch": CodexSchema.V2FsWatchResponse,
  "fs/unwatch": CodexSchema.V2FsUnwatchResponse,
  "skills/config/write": CodexSchema.V2SkillsConfigWriteResponse,
  "plugin/install": CodexSchema.V2PluginInstallResponse,
  "plugin/uninstall": CodexSchema.V2PluginUninstallResponse,
  "turn/start": CodexSchema.V2TurnStartResponse,
  "turn/settings/update": CodexSchema.V2TurnSettingsUpdateResponse,
  "turn/steer": CodexSchema.V2TurnSteerResponse,
  "turn/interrupt": CodexSchema.V2TurnInterruptResponse,
  "thread/realtime/start": CodexSchema.V2ThreadRealtimeStartResponse,
  "thread/realtime/appendAudio": CodexSchema.V2ThreadRealtimeAppendAudioResponse,
  "thread/realtime/appendText": CodexSchema.V2ThreadRealtimeAppendTextResponse,
  "thread/realtime/appendSpeech": CodexSchema.V2ThreadRealtimeAppendSpeechResponse,
  "thread/realtime/stop": CodexSchema.V2ThreadRealtimeStopResponse,
  "thread/timeline/list": CodexSchema.V2ThreadTimelineListResponse,
  "thread/realtime/listVoices": CodexSchema.V2ThreadRealtimeListVoicesResponse,
  "review/start": CodexSchema.V2ReviewStartResponse,
  "model/list": CodexSchema.V2ModelListResponse,
  "modelProvider/capabilities/read": CodexSchema.V2ModelProviderCapabilitiesReadResponse,
  "experimentalFeature/list": CodexSchema.V2ExperimentalFeatureListResponse,
  "permissionProfile/list": CodexSchema.V2PermissionProfileListResponse,
  "experimentalFeature/enablement/set": CodexSchema.V2ExperimentalFeatureEnablementSetResponse,
  "remoteControl/enable": CodexSchema.V2RemoteControlEnableResponse,
  "remoteControl/disable": CodexSchema.V2RemoteControlDisableResponse,
  "remoteControl/status/read": CodexSchema.V2RemoteControlStatusReadResponse,
  "remoteControl/pairing/start": CodexSchema.V2RemoteControlPairingStartResponse,
  "remoteControl/pairing/status": CodexSchema.V2RemoteControlPairingStatusResponse,
  "remoteControl/client/list": CodexSchema.V2RemoteControlClientsListResponse,
  "remoteControl/client/revoke": CodexSchema.V2RemoteControlClientsRevokeResponse,
  "collaborationMode/list": CodexSchema.V2CollaborationModeListResponse,
  "mock/experimentalMethod": CodexSchema.V2MockExperimentalMethodResponse,
  "environment/add": CodexSchema.V2EnvironmentAddResponse,
  "environment/info": CodexSchema.V2EnvironmentInfoResponse,
  "environment/status": CodexSchema.V2EnvironmentStatusResponse,
  "mcpServer/oauth/login": CodexSchema.V2McpServerOauthLoginResponse,
  "config/mcpServer/reload": CodexSchema.V2McpServerRefreshResponse,
  "mcpServerStatus/list": CodexSchema.V2ListMcpServerStatusResponse,
  "mcpServer/resource/read": CodexSchema.V2McpResourceReadResponse,
  "mcpServer/event/stream/start": CodexSchema.V2McpServerEventStreamStartResponse,
  "mcpServer/event/stream/stop": CodexSchema.V2McpServerEventStreamStopResponse,
  "mcpServer/tool/call": CodexSchema.V2McpServerToolCallResponse,
  "windowsSandbox/setupStart": CodexSchema.V2WindowsSandboxSetupStartResponse,
  "windowsSandbox/readiness": CodexSchema.V2WindowsSandboxReadinessResponse,
  "account/login/start": CodexSchema.V2LoginAccountResponse,
  "account/bedrock/discover": CodexSchema.V2BedrockDiscoverResponse,
  "account/bedrock/setup": CodexSchema.V2BedrockSetupResponse,
  "account/login/cancel": CodexSchema.V2CancelLoginAccountResponse,
  "account/logout": CodexSchema.V2LogoutAccountResponse,
  "account/rateLimits/read": CodexSchema.V2GetAccountRateLimitsResponse,
  "account/rateLimitResetCredit/consume": CodexSchema.V2ConsumeAccountRateLimitResetCreditResponse,
  "account/usage/read": CodexSchema.V2GetAccountTokenUsageResponse,
  "account/workspaceMessages/read": CodexSchema.V2GetWorkspaceMessagesResponse,
  "account/sendAddCreditsNudgeEmail": CodexSchema.V2SendAddCreditsNudgeEmailResponse,
  "feedback/upload": CodexSchema.V2FeedbackUploadResponse,
  "command/exec": CodexSchema.V2CommandExecResponse,
  "command/exec/write": CodexSchema.V2CommandExecWriteResponse,
  "command/exec/terminate": CodexSchema.V2CommandExecTerminateResponse,
  "command/exec/resize": CodexSchema.V2CommandExecResizeResponse,
  "process/spawn": CodexSchema.V2ProcessSpawnResponse,
  "process/writeStdin": CodexSchema.V2ProcessWriteStdinResponse,
  "process/kill": CodexSchema.V2ProcessKillResponse,
  "process/resizePty": CodexSchema.V2ProcessResizePtyResponse,
  "config/read": CodexSchema.V2ConfigReadResponse,
  "externalAgentConfig/detect": CodexSchema.V2ExternalAgentConfigDetectResponse,
  "externalAgentConfig/import": CodexSchema.V2ExternalAgentConfigImportResponse,
  "externalAgentConfig/import/recordHistory":
    CodexSchema.V2ExternalAgentConfigImportHistoryRecordResponse,
  "externalAgentConfig/import/readHistories":
    CodexSchema.V2ExternalAgentConfigImportHistoriesReadResponse,
  "config/value/write": CodexSchema.V2ConfigWriteResponse,
  "config/batchWrite": CodexSchema.V2ConfigWriteResponse,
  "configRequirements/read": CodexSchema.V2ConfigRequirementsReadResponse,
  "account/read": CodexSchema.V2GetAccountResponse,
  getConversationSummary: CodexSchema.GetConversationSummaryResponse,
  gitDiffToRemote: CodexSchema.GitDiffToRemoteResponse,
  getAuthStatus: CodexSchema.GetAuthStatusResponse,
  fuzzyFileSearch: CodexSchema.FuzzyFileSearchResponse,
  "fuzzyFileSearch/sessionStart": CodexSchema.FuzzyFileSearchSessionStartResponse,
  "fuzzyFileSearch/sessionUpdate": CodexSchema.FuzzyFileSearchSessionUpdateResponse,
  "fuzzyFileSearch/sessionStop": CodexSchema.FuzzyFileSearchSessionStopResponse,
} as const;

export const CLIENT_NOTIFICATION_PARAMS = {
  initialized: undefined,
} as const;

export const SERVER_REQUEST_PARAMS = {
  "item/commandExecution/requestApproval": CodexSchema.CommandExecutionRequestApprovalParams,
  "item/fileChange/requestApproval": CodexSchema.FileChangeRequestApprovalParams,
  "item/tool/requestUserInput": CodexSchema.ToolRequestUserInputParams,
  "mcpServer/elicitation/request": CodexSchema.McpServerElicitationRequestParams,
  "item/permissions/requestApproval": CodexSchema.PermissionsRequestApprovalParams,
  "item/tool/call": CodexSchema.DynamicToolCallParams,
  "account/chatgptAuthTokens/refresh": CodexSchema.ChatgptAuthTokensRefreshParams,
  "attestation/generate": CodexSchema.AttestationGenerateParams,
  "currentTime/read": CodexSchema.CurrentTimeReadParams,
  applyPatchApproval: CodexSchema.ApplyPatchApprovalParams,
  execCommandApproval: CodexSchema.ExecCommandApprovalParams,
} as const;

export const SERVER_REQUEST_RESPONSES = {
  "item/commandExecution/requestApproval": CodexSchema.CommandExecutionRequestApprovalResponse,
  "item/fileChange/requestApproval": CodexSchema.FileChangeRequestApprovalResponse,
  "item/tool/requestUserInput": CodexSchema.ToolRequestUserInputResponse,
  "mcpServer/elicitation/request": CodexSchema.McpServerElicitationRequestResponse,
  "item/permissions/requestApproval": CodexSchema.PermissionsRequestApprovalResponse,
  "item/tool/call": CodexSchema.DynamicToolCallResponse,
  "account/chatgptAuthTokens/refresh": CodexSchema.ChatgptAuthTokensRefreshResponse,
  "attestation/generate": CodexSchema.AttestationGenerateResponse,
  "currentTime/read": CodexSchema.CurrentTimeReadResponse,
  applyPatchApproval: CodexSchema.ApplyPatchApprovalResponse,
  execCommandApproval: CodexSchema.ExecCommandApprovalResponse,
} as const;

export const SERVER_NOTIFICATION_PARAMS = {
  error: CodexSchema.V2ErrorNotification,
  "thread/started": CodexSchema.V2ThreadStartedNotification,
  "thread/status/changed": CodexSchema.V2ThreadStatusChangedNotification,
  "thread/archived": CodexSchema.V2ThreadArchivedNotification,
  "thread/deleted": CodexSchema.V2ThreadDeletedNotification,
  "thread/unarchived": CodexSchema.V2ThreadUnarchivedNotification,
  "thread/closed": CodexSchema.V2ThreadClosedNotification,
  "thread/reverted": CodexSchema.V2ThreadRevertedNotification,
  "skills/changed": CodexSchema.V2SkillsChangedNotification,
  "thread/name/updated": CodexSchema.V2ThreadNameUpdatedNotification,
  "thread/goal/updated": CodexSchema.V2ThreadGoalUpdatedNotification,
  "thread/goal/cleared": CodexSchema.V2ThreadGoalClearedNotification,
  "thread/queue/changed": CodexSchema.V2ThreadQueueChangedNotification,
  "project/changed": CodexSchema.V2ProjectChangedNotification,
  "thread/project/updated": CodexSchema.V2ThreadProjectUpdatedNotification,
  "thread/environment/connected": CodexSchema.V2EnvironmentConnectionNotification,
  "thread/environment/disconnected": CodexSchema.V2EnvironmentConnectionNotification,
  "thread/settings/updated": CodexSchema.V2ThreadSettingsUpdatedNotification,
  "thread/tokenUsage/updated": CodexSchema.V2ThreadTokenUsageUpdatedNotification,
  "turn/started": CodexSchema.V2TurnStartedNotification,
  "hook/started": CodexSchema.V2HookStartedNotification,
  "turn/completed": CodexSchema.V2TurnCompletedNotification,
  "hook/completed": CodexSchema.V2HookCompletedNotification,
  "turn/diff/updated": CodexSchema.V2TurnDiffUpdatedNotification,
  "turn/plan/updated": CodexSchema.V2TurnPlanUpdatedNotification,
  "item/started": CodexSchema.V2ItemStartedNotification,
  "item/autoApprovalReview/started": CodexSchema.V2ItemGuardianApprovalReviewStartedNotification,
  "item/autoApprovalReview/completed":
    CodexSchema.V2ItemGuardianApprovalReviewCompletedNotification,
  "autoApprovalReview/strictReviewRequired": CodexSchema.V2StrictReviewRequiredNotification,
  "item/completed": CodexSchema.V2ItemCompletedNotification,
  "rawResponseItem/completed": CodexSchema.V2RawResponseItemCompletedNotification,
  "rawResponse/completed": CodexSchema.V2RawResponseCompletedNotification,
  "item/agentMessage/delta": CodexSchema.V2AgentMessageDeltaNotification,
  "item/plan/delta": CodexSchema.V2PlanDeltaNotification,
  "command/exec/outputDelta": CodexSchema.V2CommandExecOutputDeltaNotification,
  "process/outputDelta": CodexSchema.V2ProcessOutputDeltaNotification,
  "process/exited": CodexSchema.V2ProcessExitedNotification,
  "item/commandExecution/outputDelta": CodexSchema.V2CommandExecutionOutputDeltaNotification,
  "item/commandExecution/terminalInteraction": CodexSchema.V2TerminalInteractionNotification,
  "item/fileChange/outputDelta": CodexSchema.V2FileChangeOutputDeltaNotification,
  "item/fileChange/patchUpdated": CodexSchema.V2FileChangePatchUpdatedNotification,
  "serverRequest/resolved": CodexSchema.V2ServerRequestResolvedNotification,
  "item/mcpToolCall/progress": CodexSchema.V2McpToolCallProgressNotification,
  "mcpServer/oauthLogin/completed": CodexSchema.V2McpServerOauthLoginCompletedNotification,
  "mcpServer/startupStatus/updated": CodexSchema.V2McpServerStatusUpdatedNotification,
  "mcpServer/event/stream/notification": CodexSchema.V2McpServerEventStreamNotification,
  "account/updated": CodexSchema.V2AccountUpdatedNotification,
  "account/rateLimits/updated": CodexSchema.V2AccountRateLimitsUpdatedNotification,
  "app/list/updated": CodexSchema.V2AppListUpdatedNotification,
  "remoteControl/status/changed": CodexSchema.V2RemoteControlStatusChangedNotification,
  "externalAgentConfig/import/progress":
    CodexSchema.V2ExternalAgentConfigImportProgressNotification,
  "externalAgentConfig/import/completed":
    CodexSchema.V2ExternalAgentConfigImportCompletedNotification,
  "fs/changed": CodexSchema.V2FsChangedNotification,
  "item/reasoning/summaryTextDelta": CodexSchema.V2ReasoningSummaryTextDeltaNotification,
  "item/reasoning/summaryPartAdded": CodexSchema.V2ReasoningSummaryPartAddedNotification,
  "item/reasoning/textDelta": CodexSchema.V2ReasoningTextDeltaNotification,
  "thread/compacted": CodexSchema.V2ContextCompactedNotification,
  "model/rerouted": CodexSchema.V2ModelReroutedNotification,
  "model/verification": CodexSchema.V2ModelVerificationNotification,
  "modelProvider/authRecoveryStarted": CodexSchema.V2AuthRecoveryNotification,
  "modelProvider/authRecoveryCompleted": CodexSchema.V2AuthRecoveryNotification,
  "turn/moderationMetadata": CodexSchema.V2TurnModerationMetadataNotification,
  "model/safetyBuffering/updated": CodexSchema.V2ModelSafetyBufferingUpdatedNotification,
  warning: CodexSchema.V2WarningNotification,
  guardianWarning: CodexSchema.V2GuardianWarningNotification,
  deprecationNotice: CodexSchema.V2DeprecationNoticeNotification,
  configWarning: CodexSchema.V2ConfigWarningNotification,
  "fuzzyFileSearch/sessionUpdated": CodexSchema.FuzzyFileSearchSessionUpdatedNotification,
  "fuzzyFileSearch/sessionCompleted": CodexSchema.FuzzyFileSearchSessionCompletedNotification,
  "thread/realtime/started": CodexSchema.V2ThreadRealtimeStartedNotification,
  "thread/realtime/itemAdded": CodexSchema.V2ThreadRealtimeItemAddedNotification,
  "thread/realtime/item/started": CodexSchema.V2ThreadRealtimeItemStartedNotification,
  "thread/realtime/item/transcript/delta":
    CodexSchema.V2ThreadRealtimeItemTranscriptDeltaNotification,
  "thread/realtime/item/completed": CodexSchema.V2ThreadRealtimeItemCompletedNotification,
  "thread/realtime/transcript/delta": CodexSchema.V2ThreadRealtimeTranscriptDeltaNotification,
  "thread/realtime/transcript/done": CodexSchema.V2ThreadRealtimeTranscriptDoneNotification,
  "thread/realtime/outputAudio/delta": CodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
  "thread/realtime/sdp": CodexSchema.V2ThreadRealtimeSdpNotification,
  "thread/realtime/error": CodexSchema.V2ThreadRealtimeErrorNotification,
  "thread/realtime/closed": CodexSchema.V2ThreadRealtimeClosedNotification,
  "windows/worldWritableWarning": CodexSchema.V2WindowsWorldWritableWarningNotification,
  "windowsSandbox/setupCompleted": CodexSchema.V2WindowsSandboxSetupCompletedNotification,
  "account/login/completed": CodexSchema.V2AccountLoginCompletedNotification,
} as const;
