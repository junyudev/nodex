import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { AUTOMATION_EVENTS_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/automation-events";
import { assessSeededAutomationCheck } from "../../../scripts/scenarios/seed/automation-event";
import {
  projectAutomation,
  toCoreAutomationInput,
} from "../../host/automation-application/AutomationProjection";
import { projectInbox } from "../../shared/inbox";
import { createUuidV7 } from "../../shared/uuid-v7";

test("a failed GitHub check explains a Dry run and waits in the Inbox after switching to Ask first", async () => {
  await withCoreScenario(
    { scenarioId: AUTOMATION_EVENTS_SCENARIO_ID },
    async ({ client, manifest, seed }) => {
      const automationId = manifest.entityIdsByKey?.eventAutomation;
      const assessmentRun = manifest.entityIdsByKey?.assessmentRun;
      if (!automationId || !assessmentRun) throw new Error("Missing GitHub Automation fixtures");
      const scope = projectInbox(manifest.projectId);
      const proposals = async () =>
        (await seed.readInbox(scope)).items.filter(
          (item) => item.automationDecision?.automationId === automationId,
        );
      expect(await proposals()).toEqual([]);
      const dryRun = (await seed.readActivity()).find(
        (row) => row.description === "Would have started “Investigate failed checks”",
      );
      expect(dryRun).toMatchObject({
        reason: "The seeded CI check failed in this Project's repository.",
        evidence: { decision_session_id: assessmentRun },
      });

      const { value } = await client.automationRead({
        kind: "automation",
        automation_id: automationId,
      });
      if (value.kind !== "automation" || !value.item || value.item.trigger.kind !== "event")
        throw new Error("Missing GitHub Automation");
      const automation = value.item;
      await client.automationApply({
        operationId: createUuidV7(),
        intent: {
          kind: "update_automation",
          automation_id: automationId,
          expected_revision: automation.automation_revision,
          status: automation.status,
          automation: toCoreAutomationInput({
            ...projectAutomation(automation),
            mode: "ask_first",
          }),
        },
      });
      await assessSeededAutomationCheck(client, 2);
      expect(await proposals()).toMatchObject([
        {
          body: "Investigate the failing typecheck and propose a fix.",
          automationDecision: { status: "held" },
          proposal: { origin: "automation", state: "open", action: { type: "execute_decision" } },
        },
      ]);
      expect(
        await client.automationRead({
          kind: "automation_decisions",
          automation_id: automationId,
          window: { first: 10 },
        }),
      ).toMatchObject({
        value: {
          kind: "automation_decisions",
          window: { items: [{ mode: "ask_first", status: "held" }, { mode: "dry_run" }] },
        },
      });
    },
  );
});
