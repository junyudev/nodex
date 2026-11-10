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
      timezone: update.timezone ?? automation.timezone,
      runbookPageId:
        update.runbookPageId === undefined ? automation.runbookPageId : update.runbookPageId,
      projectId: isCron ? (update.projectId ?? null) : null,
      targetSessionId: isCron ? null : (update.targetSessionId ?? null),
      name: update.name,
      prompt: update.prompt ?? "",
      rrule: update.rrule ?? null,
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
      nextRunAt: update.status === "PAUSED" ? null : automation.nextRunAt,
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
    timezone: automation.timezone,
    backendBinding: automation.backendBinding,
    notificationPolicy: automation.notificationPolicy,
    expectedRevision: automation.automationRevision,
    runbookPageId: automation.runbookPageId,
    targetSessionId: automation.targetSessionId,
    name: automation.name,
    prompt: automation.prompt,
    rrule: automation.rrule,
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
