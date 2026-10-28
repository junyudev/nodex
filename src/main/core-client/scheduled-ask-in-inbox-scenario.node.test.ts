import { describe, expect, test } from "vite-plus/test";
import { runScenarioInbox } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  SCHEDULED_ASK_IN_INBOX_SCENARIO_ID,
  SCHEDULED_ASK_IN_INBOX_SCENARIO_REVISION,
  requireScheduledAskInInboxScenarioFacts,
} from "../../../scripts/scenarios/scenarios/scheduled-ask-in-inbox";
import { projectInbox } from "../../shared/inbox";

describe("scheduled/ask-in-inbox scenario", () => {
  test("seeds waiting, skipped, and failed scheduled decisions without starting Agents", async () => {
    await withCoreScenario({ scenarioId: SCHEDULED_ASK_IN_INBOX_SCENARIO_ID }, async (context) => {
      expect(requireScheduledAskInInboxScenarioFacts(context.facts)).toEqual({
        scenarioId: SCHEDULED_ASK_IN_INBOX_SCENARIO_ID,
        scenarioRevision: SCHEDULED_ASK_IN_INBOX_SCENARIO_REVISION,
        taskCount: 5,
        heldFiringCount: 3,
        bumpMissedCount: 2,
        skippedCount: 1,
        failedCount: 1,
        projectInboxCount: 3,
        libraryInboxCount: 1,
      });

      const { manifest, seed } = context;
      const scope = projectInbox(manifest.projectId);
      const tasks = await seed.readScheduledTasks();
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
        launch: "ask",
        cwds: [context.profile.initialProjectsDirectory],
        executionEnvironment: "worktree",
        rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        runbookPageId: manifest.pageIdsByKey.dependencyPolicy,
        runbookTitle: "Dependency policy",
        heldFiring: { pageId: manifest.pageIdsByKey.bumpDependencies, missedCount: 2 },
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
        launch: "ask",
        cwds: [],
        heldFiring: { pageId: manifest.pageIdsByKey.weeklyReadingList, missedCount: 0 },
      });
      expect(taskByKey("securityCheck")).toMatchObject({
        name: "Security check",
        projectId: manifest.projectId,
        launch: "automatic",
        heldFiring: null,
      });

      const project = (await seed.readInbox("inbox", scope)).items;
      const bump = project.filter(
        (item) => item.firing?.automationId === taskByKey("bumpDependencies")?.id,
      );
      expect(bump).toHaveLength(1);
      expect(bump[0]).toMatchObject({
        pageId: manifest.pageIdsByKey.bumpDependencies,
        body: taskByKey("bumpDependencies")?.prompt,
        scope,
        source: { kind: "scheduled_task" },
        firing: { status: "held", missedCount: 2 },
        proposal: { origin: "schedule", state: "open", action: { type: "run_task" } },
      });
      const failed = project.find(
        (item) => item.pageId === manifest.pageIdsByKey.releaseNotesDraft,
      );
      expect(failed).toMatchObject({
        state: "open",
        firing: { status: "failed" },
        proposal: { origin: "schedule", state: "failed", action: { type: "run_task" } },
      });
      expect(failed?.firing?.failureMessage).toContain("Agent is off or unavailable");
      expect(
        project.find((item) => item.pageId === manifest.pageIdsByKey.ordinaryMessage),
      ).toMatchObject({
        source: { kind: "user" },
        firing: null,
      });
      expect(project.every((item) => item.suggestionState !== "pending")).toBe(true);
      expect((await seed.readInbox("inbox")).items).toMatchObject([
        {
          pageId: manifest.pageIdsByKey.weeklyReadingList,
          scope: { kind: "library" },
          firing: { status: "held" },
        },
      ]);
      expect((await seed.readInbox("processed", scope)).items).toMatchObject([
        {
          pageId: manifest.pageIdsByKey.updateChangelog,
          state: "done",
          firing: { status: "skipped" },
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
    });
  });

  test("rejects incomplete or invalid retained counts", () => {
    const facts = {
      scenarioId: SCHEDULED_ASK_IN_INBOX_SCENARIO_ID,
      scenarioRevision: SCHEDULED_ASK_IN_INBOX_SCENARIO_REVISION,
      taskCount: 5,
      heldFiringCount: 3,
      bumpMissedCount: 2,
      skippedCount: 1,
      failedCount: 1,
      projectInboxCount: 3,
      libraryInboxCount: 1,
    };
    for (const invalid of [undefined, -1, 0.5, NaN]) {
      expect(() =>
        requireScheduledAskInInboxScenarioFacts({ ...facts, taskCount: invalid }),
      ).toThrow(/facts are invalid/u);
    }
    expect(() =>
      requireScheduledAskInInboxScenarioFacts({ ...facts, scenarioRevision: 0 }),
    ).toThrow(/facts are invalid/u);
  });
});
