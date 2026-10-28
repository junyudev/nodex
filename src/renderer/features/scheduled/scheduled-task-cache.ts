import type { CodexScheduledAutomation, CodexScheduledAutomationUpdateInput } from "@/lib/types";

export function upsertScheduledTask(
  automations: CodexScheduledAutomation[] | undefined,
  automation: CodexScheduledAutomation,
): CodexScheduledAutomation[] {
  if (!automations) return [automation];
  return automations.some((item) => item.id === automation.id)
    ? automations.map((item) => (item.id === automation.id ? automation : item))
    : [...automations, automation];
}

export function removeScheduledTask(
  automations: CodexScheduledAutomation[] | undefined,
  automationId: string,
): CodexScheduledAutomation[] {
  return (automations ?? []).filter((automation) => automation.id !== automationId);
}

/** The list as it will read once an update is saved, so the UI does not wait for the round trip. */
export function applyOptimisticScheduledTaskUpdate(
  automations: CodexScheduledAutomation[] | undefined,
  update: CodexScheduledAutomationUpdateInput,
): CodexScheduledAutomation[] | undefined {
  if (!automations) return automations;
  return automations.map((automation) => {
    if (automation.id !== update.id) return automation;
    const isCron = update.kind === "cron";
    return {
      ...automation,
      kind: update.kind,
      status: update.status,
      launch: update.launch ?? automation.launch,
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
 * so every optional field it keeps is restated.
 */
export function buildScheduledTaskStatusUpdate(
  automation: CodexScheduledAutomation,
  status: CodexScheduledAutomation["status"],
): CodexScheduledAutomationUpdateInput {
  return {
    id: automation.id,
    kind: automation.kind,
    projectId: automation.projectId,
    status,
    launch: automation.launch,
    targetSessionId: automation.targetSessionId,
    name: automation.name,
    prompt: automation.prompt,
    rrule: automation.rrule,
    model: automation.model,
    reasoningEffort: automation.reasoningEffort,
    cwds: automation.cwds,
    executionEnvironment: automation.executionEnvironment,
    localEnvironmentConfigPath: automation.localEnvironmentConfigPath,
  };
}
