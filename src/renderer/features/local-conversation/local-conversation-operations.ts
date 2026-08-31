import type { IpcApi } from "../../../shared/ipc-api";
import type {
  IpcControlChannel,
  IpcQueryChannel,
  PlainResultCommandChannel,
} from "../../../shared/ipc-endpoint-policy";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "../../lib/renderer-command";

const queryChannels = [
  "asset:resolve-path",
  "codex:account:read",
  "codex:collaboration-mode:list",
  "codex:connection:status",
  "codex:dictation:state:read",
  "codex:model:list",
  "codex:permission:state:get",
  "codex:personality:get",
  "codex:subagents:overview:read",
  "codex:thread:history-search",
  "codex:thread:background-processes:list",
  "codex:thread:background-terminals:list",
  "codex:thread:goal:get",
  "codex:threads:list",
] as const satisfies readonly IpcQueryChannel[];

const controlChannels = [
  "codex:approval:respond",
  "codex:dynamic-tool-call:respond",
  "codex:mcp-elicitation:respond",
  "codex:option-picker:respond",
  "codex:permission-request:respond",
  "codex:renderer-client:response",
  "codex:setup-codex-step:respond",
  "codex:setup-context-picker:respond",
  "codex:subagents:selected:hydrate",
  "codex:thread-follower:snapshot-applied",
  "codex:thread-owner:app-server-request",
  "codex:thread-owner:notification:ack",
  "codex:thread-owner:pending-requests:replay",
  "codex:thread-owner:stream-state:publish",
  "codex:thread:fresh-owner:adopt",
  "codex:thread:history-export:cancel",
  "codex:thread:history-export:next",
  "codex:thread:history-export:start",
  "codex:thread:history-page:load",
  "codex:thread:history-residency-pins:set",
  "codex:thread:history-search:hydrate",
  "codex:thread:resume-buffer:release",
  "codex:thread:resume:request",
  "codex:thread:snapshot:request",
  "codex:thread:stream-following:set",
  "codex:thread:stream-resync:request",
  "codex:thread:view-active:set",
  "codex:user-input:respond",
] as const satisfies readonly IpcControlChannel[];

type NonVoidPlainResultCommandChannel = {
  [Channel in PlainResultCommandChannel]: [IpcApi[Channel]["result"]] extends [void]
    ? never
    : Channel;
}[PlainResultCommandChannel];

const defineReturnedConversationCommand = <const Channel extends NonVoidPlainResultCommandChannel>(
  channel: Channel,
) =>
  defineRendererCommand({
    key: `local_conversation.${channel}`,
    channel,
    authority: "external",
    owner: "LocalConversationStore",
    protocol: { kind: "returned_value" },
    trace: { scopeKind: "thread" },
  });

const definePendingConversationCommand = <const Channel extends PlainResultCommandChannel>(
  channel: Channel,
  semanticKey = `local_conversation.${channel}`,
) =>
  defineRendererCommand({
    key: semanticKey,
    channel,
    authority: "external",
    owner: "LocalConversationStore",
    protocol: { kind: "pending_operation" },
    trace: { scopeKind: "thread" },
  });

/** Explicit semantic registry for the app-server commands owned by LocalConversationStore. */
export const localConversationCommandDefinitions = {
  "codex:conversation-unread:set": defineReturnedConversationCommand(
    "codex:conversation-unread:set",
  ),
  "codex:feedback:upload": defineReturnedConversationCommand("codex:feedback:upload"),
  "codex:permission:mode:set": defineReturnedConversationCommand("codex:permission:mode:set"),
  "codex:personality:set": definePendingConversationCommand("codex:personality:set"),
  "codex:thread-follower:action": definePendingConversationCommand("codex:thread-follower:action"),
  "codex:thread:archive": defineReturnedConversationCommand("codex:thread:archive"),
  "codex:thread:background-processes:run-action": defineReturnedConversationCommand(
    "codex:thread:background-processes:run-action",
  ),
  "codex:thread:background-terminals:clean": defineReturnedConversationCommand(
    "codex:thread:background-terminals:clean",
  ),
  "codex:thread:background-terminals:clean-silent": defineReturnedConversationCommand(
    "codex:thread:background-terminals:clean-silent",
  ),
  "codex:thread:background-terminals:terminate": defineReturnedConversationCommand(
    "codex:thread:background-terminals:terminate",
  ),
  "codex:thread:follow-up:enqueue": definePendingConversationCommand(
    "codex:thread:follow-up:enqueue",
  ),
  "codex:thread:follow-up:remove": definePendingConversationCommand(
    "codex:thread:follow-up:remove",
  ),
  "codex:thread:follow-up:reorder": definePendingConversationCommand(
    "codex:thread:follow-up:reorder",
  ),
  "codex:thread:follow-up:replace": defineReturnedConversationCommand(
    "codex:thread:follow-up:replace",
  ),
  "codex:thread:follow-up:resolve-after-fresh-start": defineReturnedConversationCommand(
    "codex:thread:follow-up:resolve-after-fresh-start",
  ),
  "codex:thread:follow-up:resume": defineReturnedConversationCommand(
    "codex:thread:follow-up:resume",
  ),
  "codex:thread:follow-up:send-now": definePendingConversationCommand(
    "codex:thread:follow-up:send-now",
  ),
  "codex:thread:name:set": defineReturnedConversationCommand("codex:thread:name:set"),
  "codex:thread:plan-implementation:remove": defineReturnedConversationCommand(
    "codex:thread:plan-implementation:remove",
  ),
  "codex:thread:presentation:set": defineReturnedConversationCommand(
    "codex:thread:presentation:set",
  ),
  "codex:thread:side-chat:discard": defineReturnedConversationCommand(
    "codex:thread:side-chat:discard",
  ),
  "codex:thread:side-chat:start": defineReturnedConversationCommand("codex:thread:side-chat:start"),
  "codex:thread:start-for-session": defineReturnedConversationCommand(
    "codex:thread:start-for-session",
  ),
  "codex:thread:unarchive": defineReturnedConversationCommand("codex:thread:unarchive"),
  "codex:turn:interrupt": defineReturnedConversationCommand("codex:turn:interrupt"),
  "codex:turn:steer": defineReturnedConversationCommand("codex:turn:steer"),
} as const;

type ThreadOwnerAction = IpcApi["codex:thread-follower:action"]["args"][0]["action"];
type ThreadOwnerActionType = ThreadOwnerAction["type"];

const followerActionDefinition = <const ActionType extends ThreadOwnerActionType>(
  actionType: ActionType,
) =>
  definePendingConversationCommand(
    "codex:thread-follower:action",
    `local_conversation.thread_owner.${actionType}`,
  );

/** Each owner-routed workflow declares its own semantic identity; additions must be exhaustive. */
export const localConversationFollowerActionDefinitions = {
  startTurn: followerActionDefinition("startTurn"),
  steerTurn: followerActionDefinition("steerTurn"),
  resumeInterruptedTurn: followerActionDefinition("resumeInterruptedTurn"),
  interruptTurn: followerActionDefinition("interruptTurn"),
  updateThreadSettings: followerActionDefinition("updateThreadSettings"),
  compactThread: followerActionDefinition("compactThread"),
  setThreadGoal: followerActionDefinition("setThreadGoal"),
  clearThreadGoal: followerActionDefinition("clearThreadGoal"),
  dismissThreadGoalResumeConfirmation: followerActionDefinition(
    "dismissThreadGoalResumeConfirmation",
  ),
  setThreadMemoryMode: followerActionDefinition("setThreadMemoryMode"),
  editLastUserTurn: followerActionDefinition("editLastUserTurn"),
  forkConversationFromTurn: followerActionDefinition("forkConversationFromTurn"),
  hydratePersistedHistoryOccurrence: followerActionDefinition("hydratePersistedHistoryOccurrence"),
  loadHistoryPage: followerActionDefinition("loadHistoryPage"),
  publishHistoryMutation: followerActionDefinition("publishHistoryMutation"),
  enqueueQueuedFollowUp: followerActionDefinition("enqueueQueuedFollowUp"),
  removeQueuedFollowUp: followerActionDefinition("removeQueuedFollowUp"),
  replaceQueuedFollowUp: followerActionDefinition("replaceQueuedFollowUp"),
  reorderQueuedFollowUps: followerActionDefinition("reorderQueuedFollowUps"),
  resumeQueuedFollowUps: followerActionDefinition("resumeQueuedFollowUps"),
  resolveQueuedFollowUpsAfterFreshStart: followerActionDefinition(
    "resolveQueuedFollowUpsAfterFreshStart",
  ),
  sendQueuedFollowUpNow: followerActionDefinition("sendQueuedFollowUpNow"),
  respondApproval: followerActionDefinition("respondApproval"),
  respondUserInput: followerActionDefinition("respondUserInput"),
  respondMcpElicitation: followerActionDefinition("respondMcpElicitation"),
  respondPermissionRequest: followerActionDefinition("respondPermissionRequest"),
  respondOptionPicker: followerActionDefinition("respondOptionPicker"),
  respondSetupCodexStep: followerActionDefinition("respondSetupCodexStep"),
  removePlanImplementationRequest: followerActionDefinition("removePlanImplementationRequest"),
} as const satisfies Record<
  ThreadOwnerActionType,
  (typeof localConversationCommandDefinitions)["codex:thread-follower:action"]
>;

type LocalConversationQueryChannel = (typeof queryChannels)[number];
type LocalConversationControlChannel = (typeof controlChannels)[number];
type LocalConversationCommandChannel = keyof typeof localConversationCommandDefinitions;
type LocalConversationOperationChannel =
  | LocalConversationQueryChannel
  | LocalConversationControlChannel
  | LocalConversationCommandChannel;

const queryChannelSet = new Set<string>(queryChannels);
const controlChannelSet = new Set<string>(controlChannels);

/**
 * The LocalConversation transport boundary is deliberately narrow: a call is accepted only
 * when its channel is listed above, and every command resolves through a semantic definition.
 */
export async function runConversationOperation<
  const Channel extends LocalConversationOperationChannel,
>(channel: Channel, ...args: IpcApi[Channel]["args"]): Promise<IpcApi[Channel]["result"]> {
  if (queryChannelSet.has(channel)) {
    return (await Reflect.apply(invokeRendererQuery, undefined, [
      channel,
      ...args,
    ])) as IpcApi[Channel]["result"];
  }
  if (controlChannelSet.has(channel)) {
    return (await Reflect.apply(invokeRendererControl, undefined, [
      channel,
      ...args,
    ])) as IpcApi[Channel]["result"];
  }

  const definition =
    channel === "codex:thread-follower:action"
      ? localConversationFollowerActionDefinitions[
          (args[0] as IpcApi["codex:thread-follower:action"]["args"][0]).action.type
        ]
      : localConversationCommandDefinitions[channel as LocalConversationCommandChannel];
  return (await Reflect.apply(invokePlainCommand, undefined, [
    definition,
    ...args,
  ])) as IpcApi[Channel]["result"];
}
