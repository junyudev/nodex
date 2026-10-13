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

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function resolveComposerFollowUpDisplayText(prompt: string, input: CodexPromptInput): string {
  const text = prompt.trim();
  if (text) return text;

  const summaries = [
    count(input.images) > 0 ? pluralize(count(input.images), "image") : null,
    count(input.textAttachments) > 0
      ? pluralize(count(input.textAttachments), "pasted text attachment")
      : null,
    count(input.commentAttachments) > 0
      ? pluralize(count(input.commentAttachments), "review comment")
      : null,
    count(input.browserAnnotationAttachments) > 0
      ? pluralize(count(input.browserAnnotationAttachments), "browser context")
      : null,
    count(input.appshots) > 0 ? pluralize(count(input.appshots), "app context") : null,
    count(input.fileAttachments) + count(input.addedFiles) > 0
      ? pluralize(count(input.fileAttachments) + count(input.addedFiles), "file")
      : null,
    count(input.skills) > 0 ? pluralize(count(input.skills), "skill") : null,
    count(input.mentions) > 0 ? pluralize(count(input.mentions), "mention") : null,
  ].filter((value): value is string => value !== null);
  return summaries.length > 0 ? summaries.join(" · ") : "Queued follow-up";
}

export function buildComposerPendingSteerRows(
  pendingSteers: CodexPendingSteer[],
): ThreadComposerShellPendingSteerRowModel[] {
  void pendingSteers;
  return [];
}

export function buildComposerQueuedFollowUpRows(
  projection: CodexQueuedFollowUpProjection,
): ThreadComposerShellQueuedFollowUpRowModel[] {
  return projection.entries.map((entry) => ({
    ...(entry.canSendNow === undefined ? {} : { canSendNow: entry.canSendNow }),
    followUpId: entry.followUpId,
    threadId: entry.threadId,
    prompt: entry.prompt,
    ...(entry.promptInput ? { promptInput: entry.promptInput } : {}),
    displayText: resolveComposerFollowUpDisplayText(entry.prompt, entry.promptInput),
    collaborationMode: entry.collaborationMode ?? null,
    pausedReason: entry.pause?.reason ?? null,
    pauseKind: entry.pause?.kind ?? null,
    isInFlight: projection.inFlightFollowUpId === entry.followUpId,
    imagePreviewSource:
      entry.promptInput.images?.[0]?.source ??
      entry.promptInput.appshots?.[0]?.imageDataUrl ??
      null,
    ledgerRevision: projection.ledgerRevision,
  }));
}
