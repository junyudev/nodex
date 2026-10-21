import type {
  InboxConfirmInput,
  InboxConfirmationDraft,
  InboxSuggestionRequestInput,
  InboxUndoInput,
  InboxChatTargetsInput,
  InboxDispatchInput,
  InboxEditInput,
  InboxPageIdsInput,
  InboxProposalInput,
  InboxSendInput,
  InboxSetImportantInput,
  InboxSetKindInput,
  InboxSetStateInput,
  InboxSummaryInput,
  InboxWindowInput,
  UpdateInboxSettingsInput,
} from "../../shared/inbox";
import {
  defineRendererCommand,
  defineLocalCommitRendererCommand,
  invokeLocalCommitCommand,
  invokePlainCommand,
  invokeRendererQuery,
} from "./renderer-command";

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
  | "inbox:delete"
  | "inbox:set-state"
  | "inbox:set-kind"
  | "inbox:set-important"
  | "inbox:request-suggestion"
  | "inbox:retry-dispatch"
  | "inbox:undo";

const sendCommand = inboxCommand("inbox.send", "inbox:send");
const editCommand = inboxCommand("inbox.edit", "inbox:edit");
const confirmCommand = inboxCommand("inbox.confirm", "inbox:confirm");
const dispatchCommand = inboxCommand("inbox.dispatch", "inbox:dispatch");
const keepCommand = inboxCommand("inbox.keep", "inbox:keep");
const deleteCommand = inboxCommand("inbox.delete", "inbox:delete");
const setStateCommand = inboxCommand("inbox.set-state", "inbox:set-state");
const setKindCommand = inboxCommand("inbox.set-kind", "inbox:set-kind");
const setImportantCommand = inboxCommand("inbox.set-important", "inbox:set-important");
const requestSuggestionCommand = inboxCommand(
  "inbox.request-suggestion",
  "inbox:request-suggestion",
);
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
export const readInboxWindow = (input: InboxWindowInput) =>
  invokeRendererQuery("inbox:window", input);
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
export const deleteInboxMessages = (input: InboxPageIdsInput) =>
  invokeLocalCommitCommand(deleteCommand, input);
export const setInboxEntryState = (input: InboxSetStateInput) =>
  invokeLocalCommitCommand(setStateCommand, input);
export const setInboxEntryKind = (input: InboxSetKindInput) =>
  invokeLocalCommitCommand(setKindCommand, input);
export const setInboxEntryImportant = (input: InboxSetImportantInput) =>
  invokeLocalCommitCommand(setImportantCommand, input);
export const requestInboxSuggestion = (input: InboxSuggestionRequestInput) =>
  invokeLocalCommitCommand(requestSuggestionCommand, input);
export const retryInboxDispatch = (input: InboxProposalInput) =>
  invokeLocalCommitCommand(retryDispatchCommand, input);
export const readInboxSettings = () => invokeRendererQuery("settings:inbox:get");
export const updateInboxSettings = (input: UpdateInboxSettingsInput) =>
  invokePlainCommand(settingsCommand, input);

export const prepareInboxConfirmation = (input: InboxConfirmationDraft) =>
  invokeRendererQuery("inbox:prepare-confirmation", input);
export const undoInboxDecision = (input: InboxUndoInput) =>
  invokeLocalCommitCommand(undoCommand, input);

export const readInboxChatTargets = (input: InboxChatTargetsInput) =>
  invokeRendererQuery("inbox:chat-targets", input);
