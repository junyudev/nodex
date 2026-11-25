import { automationsAskInInboxScenario } from "./automations-ask-in-inbox";
import { parseScenarioFacts, type ScenarioDomainRecipe } from "../contracts";
export const AUTOMATION_EVENTS_SCENARIO_ID = "automations/events";
/** Extends the Automations scenario with a CI judgement; the Source remains disabled for deterministic review. */
export const automationEventsScenario: ScenarioDomainRecipe = {
  id: AUTOMATION_EVENTS_SCENARIO_ID,
  revision: 2,
  async materialize(port, workspace) {
    const base = await automationsAskInInboxScenario.materialize(port, workspace);
    const automation = await port.createAutomation({
      kind: "cron",
      name: "Investigate failed checks",
      conditionText: "When CI fails in nodex/scenario, investigate and propose a fix",
      prompt: "Investigate the failed check and propose a fix",
      mode: "dry_run",
      projectId: base.projectId,
      cwds: [workspace],
      executionEnvironment: "local",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      trigger: {
        kind: "event",
        filter: {
          sourceId: null,
          repositories: ["nodex/scenario"],
          events: ["check_failed"],
          labels: [],
          actorClass: "any",
        },
      },
    });
    const assessmentRun = await port.assessAutomationCheck(1);
    return {
      ...base,
      scenarioId: AUTOMATION_EVENTS_SCENARIO_ID,
      scenarioRevision: 2,
      entityIdsByKey: {
        ...base.entityIdsByKey,
        eventAutomation: automation.id,
        assessmentRun,
      },
    };
  },
  async inspect(port, manifest) {
    const activity = await port.readActivity();
    const decisions = activity.filter(
      (row) =>
        row.evidence &&
        typeof row.evidence === "object" &&
        "automation_id" in row.evidence &&
        row.evidence.automation_id === manifest.entityIdsByKey?.eventAutomation,
    );
    if (
      decisions.length !== 1 ||
      decisions[0]?.description !== "Would have started “Investigate failed checks”"
    )
      throw new Error("Missing Dry run Automation decision");
    return { scenarioId: AUTOMATION_EVENTS_SCENARIO_ID, scenarioRevision: 2 };
  },
  parseFacts: parseScenarioFacts,
};
