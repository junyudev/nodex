import type {
  CodexAutomationInboxItem,
  CodexAutomationRun,
  CodexScheduledAutomation,
  CodexScheduledAutomationCreateInput,
  Estimate,
  PageOccurrence,
  PageOccurrenceUpdateInput,
  PageRunInTarget,
  Priority,
} from "../../shared/types";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import {
  CODEX_AGENT_BACKEND_BINDING,
  isCodexAgentBackendBinding,
  type AgentBackendBinding,
} from "../../shared/agent-backend";
import { canonicalizePortableRichText } from "../../shared/block-documents/portable-rich-text";
import { PRIORITY_VALUES } from "../../shared/priority";
import { isWorkflowStatus } from "../../shared/workflow-status";
import type {
  AutomationApplyResult,
  AutomationIntent,
  AutomationReadSnapshot,
} from "../core-client/types";
import {
  projectAgentBackendBindingFromCore,
  projectAgentBackendBindingToCore,
} from "../core-client/project-workspace-adapter";

export type CoreAutomationDefinition = Extract<
  AutomationReadSnapshot["value"],
  { readonly kind: "definitions" }
>["window"]["items"][number];

export type CoreAutomationRun = Extract<
  AutomationReadSnapshot["value"],
  { readonly kind: "runs" }
>["window"]["items"][number];

export type CoreAutomationInboxItem = Extract<
  AutomationReadSnapshot["value"],
  { readonly kind: "inbox" }
>["window"]["items"][number];

export type CoreScheduledPageOccurrence = Extract<
  AutomationReadSnapshot["value"],
  { readonly kind: "occurrences" }
>["window"]["items"][number];

export type CorePageOccurrenceSchedulePatch = Extract<
  AutomationIntent,
  { readonly kind: "update_page_occurrence" }
>["updates"];

export const requireCodexAutomationBackendBinding = (
  binding: AgentBackendBinding,
): typeof CODEX_AGENT_BACKEND_BINDING => {
  if (isCodexAgentBackendBinding(binding)) return CODEX_AGENT_BACKEND_BINDING;
  throw new Error("Scheduled automations currently support only the Codex Agent Backend");
};

export const projectAutomationDefinition = (
  definition: CoreAutomationDefinition,
): CodexScheduledAutomation => {
  const backendBinding = requireCodexAutomationBackendBinding(
    projectAgentBackendBindingFromCore(definition.backend_binding),
  );
  return {
    id: definition.automation_id,
    definitionRevision: definition.definition_revision,
    kind: definition.kind,
    status: definition.status,
    targetThreadId: definition.target_thread_id ?? null,
    name: definition.name,
    prompt: definition.prompt,
    rrule: definition.rrule || null,
    model: definition.model ?? null,
    reasoningEffort: definition.reasoning_effort ?? null,
    serviceTier: normalizeCodexServiceTier(definition.service_tier),
    backendBinding,
    cwds: [...definition.cwds],
    executionEnvironment: definition.execution_environment,
    localEnvironmentConfigPath: definition.local_environment_config_path ?? null,
    nextRunAt: definition.next_run_at_ms ?? null,
    lastRunAt: definition.last_run_at_ms ?? null,
    createdAt: definition.created_at_ms,
    updatedAt: definition.updated_at_ms,
  };
};

export const projectAutomationRun = (run: CoreAutomationRun): CodexAutomationRun => ({
  threadId: run.thread_id,
  automationId: run.automation_id,
  status: run.status,
  readAt: run.read_at_ms ?? null,
  threadTitle: run.thread_title ?? null,
  sourceCwd: run.source_cwd ?? null,
  inboxTitle: run.inbox_title ?? null,
  inboxSummary: run.inbox_summary ?? null,
  archivedUserMessage: run.archived_user_message ?? null,
  archivedAssistantMessage: run.archived_assistant_message ?? null,
  archivedReason: run.archived_reason ?? null,
  createdAt: run.created_at_ms,
  updatedAt: run.updated_at_ms,
});

export const projectAutomationInboxItem = (
  item: CoreAutomationInboxItem,
): CodexAutomationInboxItem => ({
  id: item.thread_id,
  automationId: item.automation_id,
  automationName: item.automation_name ?? null,
  title: item.title ?? null,
  description: item.description ?? null,
  archivedAssistantMessage: item.archived_assistant_message ?? null,
  archivedUserMessage: item.archived_user_message ?? null,
  archivedReason: item.archived_reason ?? null,
  sourceCwd: item.source_cwd ?? null,
  threadId: item.thread_id,
  readAt: item.read_at_ms ?? null,
  createdAt: item.created_at_ms,
  status: item.status,
});

const priorities = new Set<Priority>(PRIORITY_VALUES);
const estimates = new Set<Estimate>(["xs", "s", "m", "l", "xl"]);
const runTargets = new Set<PageRunInTarget>(["localProject", "newWorktree", "cloud"]);

const optionalSetValue = <T extends string>(
  value: string | null | undefined,
  allowed: ReadonlySet<T>,
  label: string,
): T | undefined => {
  if (value === null || value === undefined) return undefined;
  if (allowed.has(value as T)) return value as T;
  throw new Error(`Core Scheduled Page ${label} is invalid`);
};

const projectOccurrenceRecurrence = (
  recurrence: CoreScheduledPageOccurrence["recurrence"],
): NonNullable<PageOccurrence["recurrence"]> | undefined => {
  if (!recurrence) return undefined;
  return {
    frequency: recurrence.frequency,
    interval: recurrence.interval,
    ...(recurrence.byWeekdays ? { byWeekdays: [...recurrence.byWeekdays] } : {}),
    ...(recurrence.endCondition ? { endCondition: { ...recurrence.endCondition } } : {}),
  };
};

export const projectPageOccurrence = (occurrence: CoreScheduledPageOccurrence): PageOccurrence => {
  if (!isWorkflowStatus(occurrence.status)) {
    throw new Error("Core Scheduled Page workflow status is invalid");
  }
  const occurrenceStart = new Date(occurrence.occurrence_start_ms);
  const occurrenceEnd = new Date(occurrence.occurrence_end_ms);
  const dueDate = occurrence.due_date ? new Date(occurrence.due_date) : undefined;
  const created = new Date(occurrence.created_at);
  const runInTarget = optionalSetValue(occurrence.run_in_target, runTargets, "run target");
  const recurrence = projectOccurrenceRecurrence(occurrence.recurrence);
  if (
    !Number.isFinite(occurrenceStart.getTime()) ||
    !Number.isFinite(occurrenceEnd.getTime()) ||
    (dueDate && !Number.isFinite(dueDate.getTime())) ||
    !Number.isFinite(created.getTime())
  ) {
    throw new Error("Core Scheduled Page returned an invalid date");
  }
  if (!occurrence.occurrence_id || !occurrence.page_id) {
    throw new Error("Core Scheduled Page returned an invalid identity");
  }
  return {
    id: occurrence.occurrence_id,
    pageId: occurrence.page_id,
    pageKey: occurrence.page_key ?? null,
    status: occurrence.status,
    statusName: occurrence.status_name,
    archived: occurrence.archived,
    title: occurrence.title,
    richTitle: canonicalizePortableRichText(occurrence.rich_title),
    description: occurrence.description,
    priority: optionalSetValue(occurrence.priority, priorities, "priority"),
    estimate: optionalSetValue(occurrence.estimate, estimates, "estimate"),
    tags: [...occurrence.tags],
    ...(dueDate ? { dueDate } : {}),
    scheduledStart: occurrenceStart,
    scheduledEnd: occurrenceEnd,
    isAllDay: occurrence.is_all_day,
    ...(recurrence ? { recurrence } : {}),
    reminders: occurrence.reminders.map((reminder) => ({
      offsetMinutes: reminder.offsetMinutes,
    })),
    ...(occurrence.schedule_timezone ? { scheduleTimezone: occurrence.schedule_timezone } : {}),
    ...(occurrence.assignee ? { assignee: occurrence.assignee } : {}),
    ...(runInTarget ? { runInTarget } : {}),
    ...(occurrence.run_in_local_path ? { runInLocalPath: occurrence.run_in_local_path } : {}),
    ...(occurrence.run_in_base_branch ? { runInBaseBranch: occurrence.run_in_base_branch } : {}),
    ...(occurrence.run_in_worktree_path
      ? { runInWorktreePath: occurrence.run_in_worktree_path }
      : {}),
    ...(occurrence.run_in_environment_path
      ? { runInEnvironmentPath: occurrence.run_in_environment_path }
      : {}),
    revision: occurrence.metadata_revision,
    created,
    order: occurrence.order,
    occurrenceStart,
    occurrenceEnd,
    isRecurring: occurrence.is_recurring,
    thisAndFutureEquivalentToAll: occurrence.this_and_future_equivalent_to_all,
  };
};

export const toCoreAutomationDefinitionInput = (input: CodexScheduledAutomationCreateInput) => {
  const backendBinding = requireCodexAutomationBackendBinding(
    input.backendBinding ?? CODEX_AGENT_BACKEND_BINDING,
  );
  return {
    kind: input.kind,
    target_thread_id: input.targetThreadId ?? null,
    name: input.name,
    prompt: input.prompt ?? null,
    rrule: input.rrule ?? null,
    model: input.model ?? null,
    reasoning_effort: input.reasoningEffort ?? null,
    service_tier: normalizeCodexServiceTier(input.serviceTier),
    backend_binding: projectAgentBackendBindingToCore(backendBinding),
    cwds: input.cwds ?? null,
    execution_environment: input.executionEnvironment ?? null,
    local_environment_config_path: input.localEnvironmentConfigPath ?? null,
  };
};

export function finiteDateMilliseconds(value: Date, label: string): number;
export function finiteDateMilliseconds(
  value: Date | null | undefined,
  label: string,
): number | null;
export function finiteDateMilliseconds(
  value: Date | null | undefined,
  label: string,
): number | null {
  if (value === null || value === undefined) return null;
  const milliseconds = value.getTime();
  if (Number.isFinite(milliseconds)) return milliseconds;
  throw new Error(`Scheduled Page ${label} is invalid`);
}

export const toCoreOccurrenceSchedulePatch = (
  updates: PageOccurrenceUpdateInput["updates"],
): CorePageOccurrenceSchedulePatch => ({
  ...(Object.hasOwn(updates, "scheduledStart")
    ? { scheduled_start_ms: finiteDateMilliseconds(updates.scheduledStart, "start") }
    : {}),
  ...(Object.hasOwn(updates, "scheduledEnd")
    ? { scheduled_end_ms: finiteDateMilliseconds(updates.scheduledEnd, "end") }
    : {}),
  ...(Object.hasOwn(updates, "isAllDay") ? { is_all_day: updates.isAllDay } : {}),
  ...(Object.hasOwn(updates, "recurrence") ? { recurrence: updates.recurrence ?? null } : {}),
  ...(Object.hasOwn(updates, "reminders") ? { reminders: updates.reminders ?? [] } : {}),
  ...(Object.hasOwn(updates, "scheduleTimezone")
    ? { schedule_timezone: updates.scheduleTimezone ?? null }
    : {}),
});

export const slugifyAutomationName = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

export const requireAutomationDefinition = (
  committed: AutomationApplyResult,
  automationId: string,
): CoreAutomationDefinition => {
  const definition = committed.outcome.definitions.find(
    (candidate) => candidate.automation_id === automationId,
  );
  if (definition) return definition;
  throw new Error("Core Automation commit omitted its Definition result");
};

export const requireAutomationRun = (
  committed: AutomationApplyResult,
  threadId: string,
): CoreAutomationRun => {
  const run = committed.outcome.runs.find((candidate) => candidate.thread_id === threadId);
  if (run) return run;
  throw new Error("Core Automation commit omitted its Run result");
};
