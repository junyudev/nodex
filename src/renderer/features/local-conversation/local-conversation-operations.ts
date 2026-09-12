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
  "codex:connection:status",
  "codex:dictation:state:read",
  "codex:execution-assignments:read",
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
  "codex:app-server:request",
  "codex:thread:history-hydration:prepare",
  "codex:app-server:host-context",
  "codex:queued-messages:prepare-native",
  "codex:queued-messages:read",
  "codex:queued-messages:write",
  "codex:queued-messages:prepare",
  "codex:queued-messages:acquire-send",
  "codex:queued-messages:release-send",
  "codex:thread:native-fork:prepare",
  "codex:thread:native-fork:execute",
  "codex:thread:native-fork:accept",
  "codex:thread:native-fork:release",
  "codex:thread:native-session:prepare",
  "codex:thread:native-session:execute",
  "codex:thread:native-session:accept",
  "codex:thread:native-session:release",
  "codex:turn:native-fresh:prepare",
  "codex:turn:native-fresh:execute",
  "codex:turn:native:inject",
  "codex:turn:native-steer:prepare",
  "codex:turn:native-steer:inspect",
  "codex:turn:native-steer:execute",
  "codex:turn:native-steer:release",
  "codex:thread:interrupt-effects",
  "codex:thread:node-repl:cleanup",
  "codex:thread:settings:prepare-profile",
  "codex:turn:native:prepare",
  "codex:turn:native:execute",
  "codex:turn:native:inspect",
  "codex:turn:native:release",
  "codex:app-server:respond",
  "codex:app-server:request:abandon",
  "codex:thread:fresh-owner:adopt",
  "codex:thread:history-export:cancel",
  "codex:thread:history-export:next",
  "codex:thread:history-export:start",
  "codex:thread:resume:prepare",
  "codex:thread:resume:retry",
  "codex:thread:resume:accept",
  "codex:thread:resume:release",
  "codex:thread:snapshot:request",
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
  "codex:thread:name:set": defineReturnedConversationCommand("codex:thread:name:set"),
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
    localConversationCommandDefinitions[channel as LocalConversationCommandChannel];
  return (await Reflect.apply(invokePlainCommand, undefined, [
    definition,
    ...args,
  ])) as IpcApi[Channel]["result"];
}
