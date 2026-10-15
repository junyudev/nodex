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

const commands = {
  send: inboxCommand("inbox.send", "inbox:send"),
  edit: inboxCommand("inbox.edit", "inbox:edit"),
  confirm: inboxCommand("inbox.confirm", "inbox:confirm"),
  dispatch: inboxCommand("inbox.dispatch", "inbox:dispatch"),
  keep: inboxCommand("inbox.keep", "inbox:keep"),
  delete: inboxCommand("inbox.delete", "inbox:delete"),
  setState: inboxCommand("inbox.set-state", "inbox:set-state"),
  setKind: inboxCommand("inbox.set-kind", "inbox:set-kind"),
  requestSuggestion: inboxCommand("inbox.request-suggestion", "inbox:request-suggestion"),
  retryDispatch: inboxCommand("inbox.retry-dispatch", "inbox:retry-dispatch"),
} as const;

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
export const sendInboxMessage = (input: InboxSendInput) => invokePlainCommand(commands.send, input);
export const editInboxMessage = (input: InboxEditInput) => invokePlainCommand(commands.edit, input);
export const confirmInboxDispatch = (input: InboxConfirmInput) =>
  invokePlainCommand(commands.confirm, input);
export const dispatchInboxEntries = (input: InboxDispatchInput) =>
  invokePlainCommand(commands.dispatch, input);
export const keepInboxEntries = (input: InboxPageIdsInput) =>
  invokePlainCommand(commands.keep, input);
export const deleteInboxMessages = (input: InboxPageIdsInput) =>
  invokePlainCommand(commands.delete, input);
export const setInboxEntryState = (input: InboxSetStateInput) =>
  invokePlainCommand(commands.setState, input);
export const setInboxEntryKind = (input: InboxSetKindInput) =>
  invokePlainCommand(commands.setKind, input);
export const requestInboxSuggestion = (input: InboxPageIdsInput) =>
  invokePlainCommand(commands.requestSuggestion, input);
export const retryInboxDispatch = (input: InboxProposalInput) =>
  invokePlainCommand(commands.retryDispatch, input);
export const readInboxSettings = () => invokeRendererQuery("settings:inbox:get");
export const updateInboxSettings = (input: UpdateInboxSettingsInput) =>
  invokePlainCommand(settingsCommand, input);
