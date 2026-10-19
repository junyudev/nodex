import type {
  InboxConfirmInput,
  InboxDispatchInput,
  InboxEditInput,
  InboxPageIdsInput,
  InboxProposalInput,
  InboxSendInput,
  InboxSetKindInput,
  InboxSetStateInput,
  InboxSummaryInput,
  InboxWindowInput,
  UpdateInboxSettingsInput,
} from "../../shared/inbox";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const inboxCommand = <const Key extends string, const Channel extends InboxCommandChannel>(
  key: Key,
  channel: Channel,
) =>
  defineRendererCommand({
    key,
    channel,
    authority: "core",
    owner: "Inbox",
    protocol: { kind: "pending_operation" },
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
  | "inbox:request-suggestion"
  | "inbox:retry-dispatch";

const sendCommand = inboxCommand("inbox.send", "inbox:send");
const editCommand = inboxCommand("inbox.edit", "inbox:edit");
const confirmCommand = inboxCommand("inbox.confirm", "inbox:confirm");
const dispatchCommand = inboxCommand("inbox.dispatch", "inbox:dispatch");
const keepCommand = inboxCommand("inbox.keep", "inbox:keep");
const deleteCommand = inboxCommand("inbox.delete", "inbox:delete");
const setStateCommand = inboxCommand("inbox.set-state", "inbox:set-state");
const setKindCommand = inboxCommand("inbox.set-kind", "inbox:set-kind");
const requestSuggestionCommand = inboxCommand(
  "inbox.request-suggestion",
  "inbox:request-suggestion",
);
const retryDispatchCommand = inboxCommand("inbox.retry-dispatch", "inbox:retry-dispatch");

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
export const sendInboxMessage = (input: InboxSendInput) => invokePlainCommand(sendCommand, input);
export const editInboxMessage = (input: InboxEditInput) => invokePlainCommand(editCommand, input);
export const confirmInboxDispatch = (input: InboxConfirmInput) =>
  invokePlainCommand(confirmCommand, input);
export const dispatchInboxEntries = (input: InboxDispatchInput) =>
  invokePlainCommand(dispatchCommand, input);
export const keepInboxEntries = (input: InboxPageIdsInput) =>
  invokePlainCommand(keepCommand, input);
export const deleteInboxMessages = (input: InboxPageIdsInput) =>
  invokePlainCommand(deleteCommand, input);
export const setInboxEntryState = (input: InboxSetStateInput) =>
  invokePlainCommand(setStateCommand, input);
export const setInboxEntryKind = (input: InboxSetKindInput) =>
  invokePlainCommand(setKindCommand, input);
export const requestInboxSuggestion = (input: InboxPageIdsInput) =>
  invokePlainCommand(requestSuggestionCommand, input);
export const retryInboxDispatch = (input: InboxProposalInput) =>
  invokePlainCommand(retryDispatchCommand, input);
export const readInboxSettings = () => invokeRendererQuery("settings:inbox:get");
export const updateInboxSettings = (input: UpdateInboxSettingsInput) =>
  invokePlainCommand(settingsCommand, input);
