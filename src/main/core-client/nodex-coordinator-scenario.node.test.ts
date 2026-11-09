import { describe, expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { inspectScenario } from "../../../scripts/scenarios/seed/scenario-seed";
import {
  NODEX_COORDINATOR_SCENARIO_ID,
  requireNodexCoordinatorFacts,
} from "../../../scripts/scenarios/scenarios/nodex-coordinator";
import { projectInbox } from "../../shared/inbox";

describe("nodex-coordinator over the real Core transport", () => {
  test("persists managed reports, a blocked work graph and Coordinator Inbox decisions", async () => {
    await withCoreScenario(
      { scenarioId: NODEX_COORDINATOR_SCENARIO_ID },
      async ({ seed, manifest, client }) => {
        const facts = requireNodexCoordinatorFacts(await inspectScenario(manifest, seed));
        expect(facts).toMatchObject({
          reportCounts: { ready: 2, blocked: 1, failed: 1, dropped: 1 },
            blocked: 1,
            failed: 1,
            working: 1,
          },
          planSteps: [
            { key: "audit", blockedBy: [] },
            { key: "simplify", blockedBy: ["audit"] },
            { key: "verify", blockedBy: ["simplify"] },
          ],
          nodexStartedCount: 1,
          automaticBlockedCount: 1,
        });
        const projects = await client.workspaceRead({
          kind: "project_window",
          window: { first: 100 },
        });
        if (projects.value.kind !== "project_window") throw new Error("Expected Projects");
        expect(projects.value.projects.items.map((project) => project.name)).toEqual(["Nodex"]);
        expect((await seed.readBoard(manifest.projectId, manifest.databaseViewId)).totalRows).toBe(
        );
        expect(answer?.replyToPageId).toBe(manifest.pageIdsByKey.question);
        expect(history.find((item) => item.pageId === manifest.pageIdsByKey.question)?.state).toBe(
          "done",
        );
        expect(
          history.find((item) => item.pageId === manifest.pageIdsByKey.startedRequest)?.proposal,
        ).toMatchObject({ confirmedBy: "nodex", state: "completed", explicitRequest: true });
        const readyChats = await seed.readPageChats(manifest.pageIdsByKey.ready!);
        expect(readyChats.items[0]?.report).toMatchObject({
          outcome: "ready",
          summary: "Fixed the README install typo; checked all docs — no other occurrences.",
        });
        // The bound Coordinator stays out of the ordinary Session window.
        const sessions = await client.workspaceRead({
          kind: "task_window",
          window: { first: 100 },
          placement_scope: "all",
          order: "activity",
        });
        expect(sessions.value.kind).toBe("task_window");
        if (sessions.value.kind !== "task_window") throw new Error("Expected task window");
        expect(
          sessions.value.tasks.items.some(
            (item) => item.session.id === manifest.entityIdsByKey?.coordinator,
          ),
        ).toBe(false);
        await expect(inspectScenario(manifest, seed)).resolves.toEqual(facts);
      },
    );
  });
});
