import { defineMessages, getIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import { RUNTIME_QUEUE_HOLD_MESSAGES } from "../queue-hold-copy";
import type {
  CodexPendingSteer,
  CodexPromptInput,
  CodexQueuedFollowUpProjection,
} from "../../../lib/types";
import type {
  ThreadComposerShellPendingSteerRowModel,
  ThreadComposerShellQueuedFollowUpRowModel,
} from "../thread-stage-types";

function count(input: readonly unknown[] | undefined): number {
  return input?.length ?? 0;
}

const attachments = defineMessages({
  image: {
    id: "conversation.buildComposerFollowUpLaneModel.image",
    defaultMessage: "{count, plural, one {# image} other {# images}}",
  },
  pastedText: {
    id: "conversation.buildComposerFollowUpLaneModel.pastedText",
    defaultMessage:
      "{count, plural, one {# pasted text attachment} other {# pasted text attachments}}",
  },
  reviewComment: {
    id: "conversation.buildComposerFollowUpLaneModel.reviewComment",
    defaultMessage: "{count, plural, one {# review comment} other {# review comments}}",
  },
  annotation: {
    id: "conversation.buildComposerFollowUpLaneModel.annotation",
    defaultMessage: "{count, plural, one {# annotation} other {# annotations}}",
  },
  selection: {
    id: "conversation.buildComposerFollowUpLaneModel.selection",
    defaultMessage: "{count, plural, one {# selection} other {# selections}}",
  },
  browserContext: {
    id: "conversation.buildComposerFollowUpLaneModel.browserContext",
    defaultMessage: "{count, plural, one {# browser context} other {# browser contexts}}",
  },
  appContext: {
    id: "conversation.buildComposerFollowUpLaneModel.appContext",
    defaultMessage: "{count, plural, one {# app context} other {# app contexts}}",
  },
  file: {
    id: "conversation.buildComposerFollowUpLaneModel.file",
    defaultMessage: "{count, plural, one {# file} other {# files}}",
  },
  skill: {
    id: "conversation.buildComposerFollowUpLaneModel.skill",
    defaultMessage: "{count, plural, one {# skill} other {# skills}}",
  },
  mention: {
    id: "conversation.buildComposerFollowUpLaneModel.mention",
    defaultMessage: "{count, plural, one {# mention} other {# mentions}}",
  },
});

function summarizeAttachment(
  intl: IntlShape,
  count: number,
  message: MessageDescriptor,
): string | null {
  return count > 0 ? intl.formatMessage(message, { count }) : null;
}

function resolveComposerFollowUpDisplayText(
  prompt: string,
  input: CodexPromptInput,
  intl: IntlShape,
): string {
  const text = prompt.trim();
  if (text) return text;

  const summaries = [
    summarizeAttachment(intl, count(input.images), attachments.image),
    summarizeAttachment(intl, count(input.textAttachments), attachments.pastedText),
    summarizeAttachment(intl, count(input.commentAttachments), attachments.reviewComment),
    summarizeAttachment(intl, count(input.responseTextAnnotations), attachments.annotation),
    summarizeAttachment(intl, count(input.selectedTextAttachments), attachments.selection),
    summarizeAttachment(
      intl,
      count(input.browserAnnotationAttachments),
      attachments.browserContext,
    ),
    summarizeAttachment(intl, count(input.appshots), attachments.appContext),
    summarizeAttachment(
      intl,
      count(input.fileAttachments) + count(input.addedFiles),
      attachments.file,
    ),
    summarizeAttachment(intl, count(input.skills), attachments.skill),
    summarizeAttachment(intl, count(input.mentions), attachments.mention),
  ].filter((value): value is string => value !== null);
  return summaries.length > 0
    ? summaries.join(" · ")
    : intl.formatMessage({
        id: "conversation.buildComposerFollowUpLaneModel.queuedFollowUp",
        defaultMessage: "Queued follow-up",
      });
}

export function buildComposerPendingSteerRows(
  pendingSteers: CodexPendingSteer[],
): ThreadComposerShellPendingSteerRowModel[] {
  void pendingSteers;
  return [];
}

// The ledger keeps its original reason so its identity is independent of display language.
function formatPausedReason(reason: string | null, intl: IntlShape): string | null {
  const message = Object.values(RUNTIME_QUEUE_HOLD_MESSAGES).find(
    (entry) => entry.defaultMessage === reason,
  );
  return message ? intl.formatMessage(message) : reason;
}

export function buildComposerQueuedFollowUpRows(
  projection: CodexQueuedFollowUpProjection,
  intl: IntlShape = getIntl(),
): ThreadComposerShellQueuedFollowUpRowModel[] {
  return projection.entries.map((entry) => ({
    ...(entry.canSendNow === undefined ? {} : { canSendNow: entry.canSendNow }),
    followUpId: entry.followUpId,
    threadId: entry.threadId,
    prompt: entry.prompt,
    ...(entry.promptInput ? { promptInput: entry.promptInput } : {}),
    displayText: resolveComposerFollowUpDisplayText(entry.prompt, entry.promptInput, intl),
    collaborationMode: entry.collaborationMode ?? null,
    pausedReason: formatPausedReason(entry.pause?.reason ?? null, intl),
    pauseKind: entry.pause?.kind ?? null,
    isInFlight: projection.inFlightFollowUpId === entry.followUpId,
    imagePreviewSource:
      entry.promptInput.images?.[0]?.source ??
      entry.promptInput.appshots?.[0]?.imageDataUrl ??
      null,
    ledgerRevision: projection.ledgerRevision,
  }));
}
