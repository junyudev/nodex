import type { Automation, AutomationRunsInboxResponse, AutomationUpdateInput } from "@/lib/types";

export function upsertAutomation(
  automations: Automation[] | undefined,
  automation: Automation,
): Automation[] {
  if (!automations) return [automation];
  return automations.some((item) => item.id === automation.id)
    ? automations.map((item) => (item.id === automation.id ? automation : item))
    : [...automations, automation];
}

export function removeAutomation(
  automations: Automation[] | undefined,
  automationId: string,
): Automation[] {
  return (automations ?? []).filter((automation) => automation.id !== automationId);
}

/** A clock keeps its next run until Core recomputes it; pausing clears it. */
function optimisticTrigger(
  current: Automation["trigger"],
  update: AutomationUpdateInput,
): Automation["trigger"] {
  const { trigger } = update;
  if (trigger.kind === "event") return trigger;
  return {
    kind: "clock",
    rrule: trigger.rrule,
    timezone:
      trigger.timezone ??
      (current.kind === "clock"
        ? current.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone),
    nextRunAt: update.status === "PAUSED" || current.kind !== "clock" ? null : current.nextRunAt,
  };
}

/** The list as it will read once an update is saved, so the UI does not wait for the round trip. */
export function applyOptimisticAutomationUpdate(
  automations: Automation[] | undefined,
  update: AutomationUpdateInput,
): Automation[] | undefined {
  if (!automations) return automations;
  return automations.map((automation) => {
    if (automation.id !== update.id) return automation;
    const isCron = update.kind === "cron";
    return {
      ...automation,
      kind: update.kind,
      status: update.status,
      mode: update.mode ?? automation.mode,
      scope: update.scope ?? automation.scope,
      ownerMemberId: update.ownerMemberId ?? automation.ownerMemberId,
      conditionText: update.conditionText ?? automation.conditionText,
      trigger: optimisticTrigger(automation.trigger, update),
      runbookPageId:
        update.runbookPageId === undefined ? automation.runbookPageId : update.runbookPageId,
      projectId: isCron ? (update.projectId ?? null) : null,
      targetSessionId: isCron ? null : (update.targetSessionId ?? null),
      name: update.name,
      prompt: update.prompt ?? "",
      model: isCron ? (update.model ?? null) : null,
      reasoningEffort: isCron ? (update.reasoningEffort ?? null) : null,
      cwds: isCron ? [...(update.cwds ?? [])] : [],
      executionEnvironment: isCron
        ? (update.executionEnvironment ?? automation.executionEnvironment)
        : "worktree",
      localEnvironmentConfigPath: isCron
        ? update.localEnvironmentConfigPath === undefined
          ? automation.localEnvironmentConfigPath
          : update.localEnvironmentConfigPath
        : null,
    };
  });
}

/**
 * The full update that changes only a task's status. An update replaces the whole definition,
 * so every optional field it keeps, the runbook included, is restated.
 */
export function buildAutomationStatusUpdate(
  automation: Automation,
  status: Automation["status"],
): AutomationUpdateInput {
  return {
    id: automation.id,
    kind: automation.kind,
    projectId: automation.projectId,
    status,
    mode: automation.mode,
    scope: automation.scope,
    ownerMemberId: automation.ownerMemberId,
    conditionText: automation.conditionText,
    trigger:
      automation.trigger.kind === "clock"
        ? { kind: "clock", rrule: automation.trigger.rrule, timezone: automation.trigger.timezone }
        : automation.trigger,
    backendBinding: automation.backendBinding,
    notificationPolicy: automation.notificationPolicy,
    expectedRevision: automation.automationRevision,
    runbookPageId: automation.runbookPageId,
    targetSessionId: automation.targetSessionId,
    name: automation.name,
    prompt: automation.prompt,
    model: automation.model,
    reasoningEffort: automation.reasoningEffort,
    serviceTier: automation.serviceTier,
    cwds: automation.cwds,
    executionEnvironment: automation.executionEnvironment,
    localEnvironmentConfigPath: automation.localEnvironmentConfigPath,
  };
}

/** The runs as they will read once marked read, so an unread mark clears without a round trip. */
export function applyOptimisticRunsRead(
  runs: AutomationRunsInboxResponse | undefined,
  runIds: readonly string[],
  readAt: number,
): AutomationRunsInboxResponse | undefined {
  if (!runs) return runs;
  const read = new Set(runIds);
  const unreadRuns = runs.unreadRunCounts.unreadRuns.filter((run) => !read.has(run.runId));
  const cleared = runs.unreadRunCounts.unreadRuns.length - unreadRuns.length;
  return {
    items: runs.items.map((item) =>
      read.has(item.runId) && item.readAt === null ? { ...item, readAt } : item,
    ),
    unreadRunCounts: {
      total: Math.max(0, runs.unreadRunCounts.total - cleared),
      automationIds: [...new Set(unreadRuns.map((run) => run.automationId))],
      unreadRuns,
    },
  };
}
