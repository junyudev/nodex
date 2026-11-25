import { describe, expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { inspectScenario } from "../../../scripts/scenarios/seed/scenario-seed";
import {
  NODEX_COORDINATION_SCENARIO_ID,
  requireNodexCoordinationFacts,
} from "../../../scripts/scenarios/scenarios/nodex-coordination";
import { projectInbox } from "../../shared/inbox";

describe("nodex-coordination over the real Core transport", () => {
  test("persists managed reports, a blocked work graph and request-bound routing decisions", async () => {
    await withCoreScenario(
      { scenarioId: NODEX_COORDINATION_SCENARIO_ID },
      async ({ seed, manifest, client }) => {
        const facts = requireNodexCoordinationFacts(await inspectScenario(manifest, seed));
        expect(facts).toMatchObject({
          cardCount: 14,
          managedChatCount: 9,
          reportCounts: { ready: 2, blocked: 1, failed: 1, dropped: 1 },
          turnCounts: {
            review: 1,
            reply: 1,
            blocked: 1,
            failed: 1,
            working: 1,
            queued: 1,
            paused: 1,
            question: 1,
            waiting_on_prerequisite: 2,
            ready_to_start: 1,
            none: 2,
          },
          inboxRowCounts: { intake: 2, turn: 6, answer: 1, problem: 1 },
          planSteps: [
            { key: "audit", blockedBy: [] },
            { key: "simplify", blockedBy: ["audit"] },
            { key: "verify", blockedBy: ["simplify"] },
          ],
          nodexStartedCount: 1,
          projectTurnCount: 6,
          automaticBlockedCount: 1,
        });
        const projects = await client.workspaceRead({
          kind: "project_window",
          window: { first: 100 },
        });
        if (projects.value.kind !== "project_window") throw new Error("Expected Projects");
        expect(projects.value.projects.items.map((project) => project.name)).toEqual(["Nodex"]);
        expect((await seed.readBoard(manifest.projectId, manifest.databaseViewId)).totalRows).toBe(
          14,
        );
        // Work waiting in line, paused work and work with a pull request read as Core decides them.
        expect(await seed.readPageTurn(manifest.pageIdsByKey.queued!)).toMatchObject({
          reason: "queued",
          actor: { kind: "agent", assignee: { instance_id: "codex" } },
        });
        expect(
          await client.workspaceRead({
            kind: "session_execution_observer",
            session_id: manifest.entityIdsByKey!.queuedSession!,
          }),
        ).toMatchObject({ value: { observer: { observation: { queue: { position: 2 } } } } });
        expect((await seed.readPageTurn(manifest.pageIdsByKey.paused!)).hold?.scope).toEqual({
          kind: "page",
          page_id: manifest.pageIdsByKey.paused,
        });
        const workspace = await client.workspaceRead({
          kind: "page_workspace",
          page_id: manifest.pageIdsByKey.blocked!,
        });
        if (workspace.value.kind !== "page_workspace") throw new Error("Expected a Page Workspace");
        expect(workspace.value.workspace?.branch_name).toBe("nodex-2-add-team-invitations");
        expect(workspace.value.pull_request).toMatchObject({ number: 2, state: "OPEN" });
        const library = (await seed.readInbox()).items;
        const activity = await seed.readActivity();
        for (const prefix of ["message:", "handback:", "problem-open:"])
          expect(activity.some((row) => row.id.startsWith(prefix))).toBe(true);
        expect(facts.activityCount).toBe(activity.length);
        // Routing advice is not a fact of its own; each handled message is one line per decision.
        expect(activity.some((row) => /^(proposal|confirmation|intake):/u.test(row.id))).toBe(
          false,
        );
        expect(
          activity.find((row) => row.message?.pageId === manifest.pageIdsByKey.startedRequest)
            ?.description,
        ).toMatch(/^Sent “.+” to a new chat on your request$/u);
        // Nodex's answer handles its question, and Activity says so.
        expect(
          activity.find((row) => row.message?.pageId === manifest.pageIdsByKey.question)
            ?.description,
        ).toMatch(/^Answered “.+”$/u);
        expect(library.find((item) => item.rowKind === "problem")?.problem).toMatchObject({
          id: manifest.entityIdsByKey?.sourceProblem,
          kind: "source_failing",
          fix: "reconnect",
        });

        const review = library.find((item) => item.pageId === manifest.pageIdsByKey.ready);
        expect(review?.rowKind).toBe("turn");
        expect(review?.turn?.turn.reason).toBe("review");
        const reply = library.find((item) => item.pageId === manifest.pageIdsByKey.reply);
        expect(reply?.turn?.turn.reason).toBe("reply");
        expect(reply?.body).toBe(
          "The release notes are drafted. Should I publish them with the release or now?",
        );
        const returned = library.find((item) => item.pageId === manifest.pageIdsByKey.handedBack);
        expect(returned?.body).toBe("Update the keyboard shortcut guide.");
        expect(returned?.handback).toMatchObject({
          reason: "The keyboard navigation chat owns this change.",
          chat: { display_title: "Documentation" },
        });
        const answer = library.find((item) => item.pageId === manifest.pageIdsByKey.answer);
        expect(answer?.rowKind).toBe("answer");
        expect(answer?.replyToPageId).toBe(manifest.pageIdsByKey.question);
        const history = await seed.readHandledMessages();
        expect(
          history.find((item) => item.pageId === manifest.pageIdsByKey.question)?.pageStatus?.id,
        ).toBe("done");
        expect(
          history.find((item) => item.pageId === manifest.pageIdsByKey.startedRequest)?.proposal,
        ).toMatchObject({ confirmedBy: "nodex", state: "completed", explicitRequest: true });
        expect((await seed.readInbox(projectInbox(manifest.projectId))).items).toHaveLength(6);
        const readyChats = await seed.readPageChats(manifest.pageIdsByKey.ready!);
        expect(readyChats.items[0]?.report).toMatchObject({
          outcome: "ready",
          summary: "Fixed the README install typo; checked all docs — no other occurrences.",
        });
        const routed = activity.find(
          (row) => row.message?.pageId === manifest.pageIdsByKey.startedRequest,
        );
        const evidence = routed?.evidence as { decision_session_id?: string } | undefined;
        const decisionId = evidence?.decision_session_id;
        if (!decisionId) throw new Error("Expected Activity to name its decision run");
        expect(
          await client.workspaceRead({ kind: "decision_run", session_id: decisionId }),
        ).toMatchObject({ value: { decision_run: { session_id: decisionId, kind: "routing" } } });
        const sessions = await client.workspaceRead({
          kind: "task_window",
          window: { first: 100 },
          placement_scope: "all",
          order: "activity",
        });
        expect(sessions.value.kind).toBe("task_window");
        if (sessions.value.kind !== "task_window") throw new Error("Expected task window");
        expect(sessions.value.tasks.items.some((item) => item.session.id === decisionId)).toBe(
          false,
        );
        await expect(inspectScenario(manifest, seed)).resolves.toEqual(facts);
      },
    );
  });
});
