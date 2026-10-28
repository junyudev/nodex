import type { DatabasePage, PageInput, DatabasePageSummary } from "./types";
import { plainTextToPortableRichText } from "./block-documents/portable-rich-text";
import { extractMarkdownText, markdownPreview } from "./nodex-markdown";

export const PAGE_DESCRIPTION_PREVIEW_LENGTH = 240;

export function summarizePageDescription(
  description: string,
): Pick<DatabasePageSummary, "descriptionPreview" | "descriptionLength" | "hasDescription"> {
  const preview = markdownPreview(extractMarkdownText(description));
  return {
    descriptionPreview: preview,
    descriptionLength: description.length,
    hasDescription: description.trim().length > 0,
  };
}

export function toDatabasePageSummary(page: DatabasePage): DatabasePageSummary {
  const { description, ...rest } = page;
  return {
    ...rest,
    ...summarizePageDescription(description),
  };
}

export function pageInputToSummaryPatch(updates: Partial<PageInput>): Partial<DatabasePageSummary> {
  const patch: Partial<DatabasePageSummary> = {};

  if ("title" in updates) {
    const title = updates.title ?? "";
    patch.title = title;
    patch.richTitle = plainTextToPortableRichText(title);
  }
  if ("description" in updates) {
    Object.assign(patch, summarizePageDescription(updates.description ?? ""));
  }
  if ("priority" in updates) patch.priority = updates.priority ?? undefined;
  if ("estimate" in updates) patch.estimate = updates.estimate ?? undefined;
  if ("tags" in updates && Array.isArray(updates.tags)) patch.tags = updates.tags;
  if ("dueDate" in updates) patch.dueDate = updates.dueDate ?? undefined;
  if ("scheduledStart" in updates) patch.scheduledStart = updates.scheduledStart ?? undefined;
  if ("scheduledEnd" in updates) patch.scheduledEnd = updates.scheduledEnd ?? undefined;
  if ("isAllDay" in updates) patch.isAllDay = updates.isAllDay ?? undefined;
  if ("recurrence" in updates) patch.recurrence = updates.recurrence ?? undefined;
  if ("reminders" in updates && Array.isArray(updates.reminders))
    patch.reminders = updates.reminders;
  if ("scheduleTimezone" in updates) patch.scheduleTimezone = updates.scheduleTimezone ?? undefined;
  if ("assignee" in updates) patch.assignee = updates.assignee ?? undefined;
  if ("runInTarget" in updates) patch.runInTarget = updates.runInTarget ?? undefined;
  if ("runInLocalPath" in updates) patch.runInLocalPath = updates.runInLocalPath ?? undefined;
  if ("runInBaseBranch" in updates) patch.runInBaseBranch = updates.runInBaseBranch ?? undefined;
  if ("runInWorktreePath" in updates)
    patch.runInWorktreePath = updates.runInWorktreePath ?? undefined;
  if ("runInEnvironmentPath" in updates)
    patch.runInEnvironmentPath = updates.runInEnvironmentPath ?? undefined;

  return patch;
}
