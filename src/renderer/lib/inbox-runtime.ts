import { findContent } from "./find";
import type { ActivityWindowInput, RetryProblemInput } from "../../shared/inbox";
import type {
  InboxConfirmInput,
  InboxConfirmationDraft,
  InboxSuggestionRequestInput,
  InboxSuggestionStopInput,
  InboxUndoInput,
  InboxChatTargetsInput,
  InboxDispatchInput,
  InboxEditInput,
  InboxPageIdsInput,
  InboxProposalInput,
  InboxSendInput,
  InboxSetImportantInput,
  InboxSetKindInput,
  InboxSetSnoozeInput,
  InboxSummaryInput,
  InboxStreamInput,
  UpdateInboxSettingsInput,
} from "../../shared/inbox";
import {
  defineRendererCommand,
  defineLocalCommitRendererCommand,
  invokeLocalCommitCommand,
  invokePlainCommand,
  invokeRendererQuery,
} from "./renderer-command";

export type { InboxDispatchAction, InboxItem, InboxSummary } from "../../shared/inbox";

const inboxCommand = <const Key extends string, const Channel extends InboxCommandChannel>(
  key: Key,
  channel: Channel,
) =>
  defineLocalCommitRendererCommand({
    key,
    channel,
    authority: "core",
    owner: "Inbox",
    protocol: { kind: "receipt_fenced_projection", presentation: "pending" },
  });

type InboxCommandChannel =
  | "inbox:send"
  | "inbox:edit"
  | "inbox:confirm"
  | "inbox:dispatch"
  | "inbox:keep"
  | "inbox:snooze"
  | "inbox:wake"
  | "inbox:delete"
  | "inbox:mark-done"
  | "inbox:return"
  | "inbox:set-kind"
  | "inbox:set-important"
  | "inbox:request-suggestion"
  | "inbox:stop-suggestion"
  | "inbox:retry-dispatch"
  | "inbox:retry-problem"
  | "inbox:undo";

const sendCommand = inboxCommand("inbox.send", "inbox:send");
const editCommand = inboxCommand("inbox.edit", "inbox:edit");
const confirmCommand = inboxCommand("inbox.confirm", "inbox:confirm");
const dispatchCommand = inboxCommand("inbox.dispatch", "inbox:dispatch");
const snoozeCommand = inboxCommand("inbox.snooze", "inbox:snooze");
const wakeCommand = inboxCommand("inbox.wake", "inbox:wake");
const keepCommand = inboxCommand("inbox.keep", "inbox:keep");
const deleteCommand = inboxCommand("inbox.delete", "inbox:delete");
const markDoneCommand = inboxCommand("inbox.mark-done", "inbox:mark-done");
const returnMessagesCommand = inboxCommand("inbox.return", "inbox:return");
const setKindCommand = inboxCommand("inbox.set-kind", "inbox:set-kind");
const setImportantCommand = inboxCommand("inbox.set-important", "inbox:set-important");
const requestSuggestionCommand = inboxCommand(
  "inbox.request-suggestion",
  "inbox:request-suggestion",
);
const stopSuggestionCommand = inboxCommand("inbox.stop-suggestion", "inbox:stop-suggestion");
const retryDispatchCommand = inboxCommand("inbox.retry-dispatch", "inbox:retry-dispatch");

const undoCommand = inboxCommand("inbox.undo", "inbox:undo");

const settingsCommand = defineRendererCommand({
  key: "settings.inbox.update",
  channel: "settings:inbox:update",
  authority: "main",
  owner: "Settings",
  protocol: { kind: "pending_operation" },
});

export const readInboxSummary = (input: InboxSummaryInput) =>
  invokeRendererQuery("inbox:summary", input);
export const readInboxCounts = () => invokeRendererQuery("inbox:counts");
export const readInboxWindow = (input: InboxStreamInput) =>
  invokeRendererQuery("inbox:window", input);
export const readInboxSnoozeWindow = (input: Omit<InboxStreamInput, "filter">) =>
  readInboxWindow({ ...input, filter: "snoozed" });
export const sendInboxMessage = (input: InboxSendInput) =>
  invokeLocalCommitCommand(sendCommand, input);
export const editInboxMessage = (input: InboxEditInput) =>
  invokeLocalCommitCommand(editCommand, input);
export const confirmInboxDispatch = (input: InboxConfirmInput) =>
  invokeLocalCommitCommand(confirmCommand, input);
export const dispatchInboxEntries = (input: InboxDispatchInput) =>
  invokeLocalCommitCommand(dispatchCommand, input);
export const keepInboxEntries = (input: InboxPageIdsInput) =>
  invokeLocalCommitCommand(keepCommand, input);
export const setInboxSnooze = (input: InboxSetSnoozeInput) =>
  invokeLocalCommitCommand(snoozeCommand, input);
export const wakeInboxEntries = (input: InboxPageIdsInput) =>
  invokeLocalCommitCommand(wakeCommand, input);
export const deleteInboxMessages = (input: InboxPageIdsInput) =>
  invokeLocalCommitCommand(deleteCommand, input);
export const markInboxMessagesDone = (input: InboxPageIdsInput) =>
  invokeLocalCommitCommand(markDoneCommand, input);
export const returnInboxMessages = (input: InboxPageIdsInput) =>
  invokeLocalCommitCommand(returnMessagesCommand, input);
export const setInboxEntryKind = (input: InboxSetKindInput) =>
  invokeLocalCommitCommand(setKindCommand, input);
export const setInboxEntryImportant = (input: InboxSetImportantInput) =>
  invokeLocalCommitCommand(setImportantCommand, input);
export const requestInboxSuggestion = (input: InboxSuggestionRequestInput) =>
  invokeLocalCommitCommand(requestSuggestionCommand, input);
export const stopInboxSuggestion = (input: InboxSuggestionStopInput) =>
  invokeLocalCommitCommand(stopSuggestionCommand, input);
export const retryInboxDispatch = (input: InboxProposalInput) =>
  invokeLocalCommitCommand(retryDispatchCommand, input);
export const readInboxSettings = () => invokeRendererQuery("settings:inbox:get");
export const updateInboxSettings = (input: UpdateInboxSettingsInput) =>
  invokePlainCommand(settingsCommand, input);

export const prepareInboxConfirmation = (input: InboxConfirmationDraft) =>
  invokeRendererQuery("inbox:prepare-confirmation", input);
export const undoInboxDecision = (input: InboxUndoInput) =>
  invokeLocalCommitCommand(undoCommand, input);

export async function readInboxChatTargets(input: InboxChatTargetsInput) {
  const result = await findContent({
    query: input.query,
    kinds: ["chat"],
    place: input.scope.kind === "project" ? input.scope : { kind: "everywhere" },
    limit: input.first ?? 50,
    cursor: input.after ?? undefined,
    startedChatsOnly: true,
  });
  if (
    result.coverage.some(
      (source) => source.source === "chat_catalog" && source.state === "unavailable",
    )
  )
    throw new Error("Chat search is unavailable");
  const items = result.hits.flatMap((hit): import("../../shared/inbox").InboxChat[] => {
    if (hit.kind !== "chat" || hit.archived) return [];
    const { chat } = hit.chatMatch;
    return [
      {
        sessionId: chat.sessionId,
        projectId: chat.projectId,
        projectName: chat.projectName,
        displayTitle: chat.title,
        threadId: chat.threadId,
        archived: hit.archived,
        unread: chat.unread,
        executionRef: null,
        status: null,
      },
    ];
  });
  return { items, nextCursor: result.nextCursor };
}

const openNodexCommand = defineRendererCommand({
  key: "inbox.open-nodex",
  channel: "inbox:open-nodex",
  authority: "main",
  owner: "Inbox",
  protocol: { kind: "pending_operation" },
});
const resetNodexCommand = defineRendererCommand({
  key: "inbox.reset-nodex",
  channel: "inbox:reset-nodex",
  authority: "main",
  owner: "Inbox",
  protocol: { kind: "pending_operation" },
});
export const openNodex = () => invokePlainCommand(openNodexCommand);
export const resetNodex = () => invokePlainCommand(resetNodexCommand);

export const readInboxEntry = (pageId: string) => invokeRendererQuery("inbox:entry", pageId);

export const readInboxReplyDestination = (pageId: string, body: string) =>
  invokeRendererQuery("inbox:reply-destination", pageId, body);

const retryProblemCommand = inboxCommand("inbox.retry-problem", "inbox:retry-problem");
export const retryInboxProblem = (input: RetryProblemInput) =>
  invokeLocalCommitCommand(retryProblemCommand, input);
export const readInboxActivity = (input: ActivityWindowInput) =>
  invokeRendererQuery("inbox:activity", input);

export const readInboxSkillAvailability = (
  input: import("../../shared/inbox").InboxSkillAvailabilityInput,
) => invokeRendererQuery("inbox:skill-availability", input);
