import { describe, expect, test } from "vite-plus/test";
import { runScenarioInbox } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID,
  AUTOMATIONS_ASK_IN_INBOX_SCENARIO_REVISION,
  requireAutomationsAskInInboxScenarioFacts,
} from "../../../scripts/scenarios/scenarios/automations-ask-in-inbox";
import { projectInbox } from "../../shared/inbox";

describe("automations/ask-in-inbox scenario", () => {
  test("seeds waiting, skipped, and failed Automation decisions without starting Agents", async () => {
    await withCoreScenario(
      { scenarioId: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID },
      async (context) => {
        expect(requireAutomationsAskInInboxScenarioFacts(context.facts)).toEqual({
          scenarioId: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID,
          scenarioRevision: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_REVISION,
          taskCount: 5,
          heldDecisionCount: 3,
          bumpMissedCount: 2,
          skippedCount: 1,
          failedCount: 1,
          projectInboxCount: 3,
          allInboxCount: 4,
        });

        const { manifest, seed } = context;
        const scope = projectInbox(manifest.projectId);
        const tasks = await seed.readAutomations();
        const taskByKey = (key: string) =>
          tasks.find((task) => task.id === manifest.entityIdsByKey?.[key]);
        expect(tasks.every((task) => task.kind === "cron")).toBe(true);
        expect(
          tasks.every(
            (task) =>
              task.backendBinding.kind === "codex" &&
              task.model === "gpt-6.1-sol" &&
              task.reasoningEffort === "high",
          ),
        ).toBe(true);
        expect(taskByKey("bumpDependencies")).toMatchObject({
          name: "Bump dependency versions",
          projectId: manifest.projectId,
          mode: "ask_first",
          cwds: [context.profile.projectsDirectory.replaceAll("\\", "/")],
          executionEnvironment: "worktree",
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
          runbookPageId: manifest.pageIdsByKey.dependencyPolicy,
          runbookTitle: "Dependency policy",
          heldDecision: { pageId: manifest.pageIdsByKey.bumpDependencies, missedCount: 2 },
        });
        const runbook = await seed.readPage(
          manifest.projectId,
          manifest.pageIdsByKey.dependencyPolicy!,
        );
        expect(runbook).toMatchObject({ title: "Dependency policy", documentReadiness: "ready" });
        expect(runbook.descriptionPreview).toContain("Pin the Node runtime");
        expect(taskByKey("weeklyReadingList")).toMatchObject({
          name: "Weekly reading list",
          projectId: null,
          mode: "ask_first",
          cwds: [],
          heldDecision: { pageId: manifest.pageIdsByKey.weeklyReadingList, missedCount: 0 },
        });
        expect(taskByKey("securityCheck")).toMatchObject({
          name: "Security check",
          projectId: manifest.projectId,
          mode: "run",
          heldDecision: null,
        });

        const project = (await seed.readInbox(scope)).items;
        const bump = project.filter(
          (item) => item.automationDecision?.automationId === taskByKey("bumpDependencies")?.id,
        );
        expect(bump).toHaveLength(1);
        expect(bump[0]).toMatchObject({
          pageId: manifest.pageIdsByKey.bumpDependencies,
          body: taskByKey("bumpDependencies")?.prompt,
          scope,
          source: { kind: "automation" },
          automationDecision: { status: "held", missedCount: 2 },
          proposal: { origin: "automation", state: "open", action: { type: "execute_decision" } },
        });
        const failed = project.find(
          (item) => item.pageId === manifest.pageIdsByKey.releaseNotesDraft,
        );
        expect(failed).toMatchObject({
          state: "open",
          automationDecision: { status: "failed" },
          proposal: { origin: "automation", state: "failed", action: { type: "execute_decision" } },
        });
        expect(failed?.automationDecision?.failureMessage).toContain("Agent is off or unavailable");
        expect(
          project.find((item) => item.pageId === manifest.pageIdsByKey.ordinaryMessage),
        ).toMatchObject({
          source: { kind: "user" },
          automationDecision: null,
        });
        expect(project.every((item) => item.suggestionState !== "pending")).toBe(true);
        const all = (await seed.readInbox()).items;
        expect(
          all.find((item) => item.pageId === manifest.pageIdsByKey.weeklyReadingList),
        ).toMatchObject({
          scope: { kind: "library" },
          automationDecision: { status: "held" },
        });
        // Activity keeps each decision: the run the person started, which then failed and waits
        // for Retry, and the run they skipped.
        expect(await seed.readHandledMessages(scope)).toMatchObject([
          {
            pageId: manifest.pageIdsByKey.releaseNotesDraft,
            automationDecision: { status: "failed" },
          },
          {
            pageId: manifest.pageIdsByKey.updateChangelog,
            state: "done",
            automationDecision: { status: "skipped" },
          },
        ]);

        expect(await runScenarioInbox(context.runtime, (inbox) => inbox.outbox(20))).toEqual([]);
        expect(
          await context.client.automationRead({ kind: "runs", window: { first: 20 } }),
        ).toMatchObject({
          value: { kind: "runs", window: { items: [] } },
        });
        expect(
          await context.client.automationRead({ kind: "leases", window: { first: 20 } }),
        ).toMatchObject({
          value: { kind: "leases", window: { items: [] } },
        });
      },
    );
  });

  test("rejects incomplete or invalid retained counts", () => {
    const facts = {
      scenarioId: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID,
      scenarioRevision: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_REVISION,
      taskCount: 5,
      heldDecisionCount: 3,
      bumpMissedCount: 2,
      skippedCount: 1,
      failedCount: 1,
      projectInboxCount: 3,
      allInboxCount: 4,
    };
    for (const invalid of [undefined, -1, 0.5, NaN]) {
      expect(() =>
        requireAutomationsAskInInboxScenarioFacts({ ...facts, taskCount: invalid }),
      ).toThrow(/facts are invalid/u);
    }
    expect(() =>
      requireAutomationsAskInInboxScenarioFacts({ ...facts, scenarioRevision: 0 }),
    ).toThrow(/facts are invalid/u);
  });
});
