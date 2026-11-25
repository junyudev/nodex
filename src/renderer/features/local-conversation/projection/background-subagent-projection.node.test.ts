import { describe, expect, test, vi } from "vite-plus/test";
import {
  buildBackgroundSubagentCompactStripModel,
  getBackgroundSubagentListRows,
} from "./background-subagent-summary-model";
import type { CodexCanonicalDelegatedTaskItem } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { timelineOwnerFixture } from "./normalized-timeline.test-fixtures";
import { createDelegatedTaskReadQuery } from "./delegated-task-read-query";

describe("background subagent summary model", () => {
  function row(
    id: string,
    input: { showInlineActivity: boolean; status: "active" | "waiting" | "done" },
  ) {
    return {
      id,
      showInlineActivity: input.showInlineActivity,
      status: input.status,
    };
  }

  describe("background subagent summary model", () => {
    test("shows up to four working inline avatars but counts every inline row", () => {
      const model = buildBackgroundSubagentCompactStripModel([
        row("working-1", { showInlineActivity: true, status: "active" }),
        row("working-2", { showInlineActivity: true, status: "waiting" }),
        row("working-3", { showInlineActivity: true, status: "active" }),
        row("working-4", { showInlineActivity: true, status: "waiting" }),
        row("working-5", { showInlineActivity: true, status: "active" }),
        row("done-1", { showInlineActivity: true, status: "done" }),
        row("listed-1", { showInlineActivity: false, status: "active" }),
      ]);

      expect(model.displayRows.map((entry) => entry.id).join(",")).toBe(
        "working-1,working-2,working-3,working-4",
      );
      expect(`${model.workingCount}:${model.doneCount}`).toBe("5:1");
    });

    test("shows the first four done inline avatars when no inline row is working", () => {
      const model = buildBackgroundSubagentCompactStripModel([
        row("done-1", { showInlineActivity: true, status: "done" }),
        row("done-2", { showInlineActivity: true, status: "done" }),
        row("done-3", { showInlineActivity: true, status: "done" }),
        row("done-4", { showInlineActivity: true, status: "done" }),
        row("done-5", { showInlineActivity: true, status: "done" }),
      ]);

      expect(model.displayRows.map((entry) => entry.id).join(",")).toBe(
        "done-1,done-2,done-3,done-4",
      );
      expect(`${model.workingCount}:${model.doneCount}`).toBe("0:5");
    });

    test("lists only non-inline rows below the compact strip", () => {
      const rows = [
        row("inline", { showInlineActivity: true, status: "active" }),
        row("listed", { showInlineActivity: false, status: "active" }),
      ];

      expect(
        getBackgroundSubagentListRows(rows)
          .map((entry) => entry.id)
          .join(","),
      ).toBe("listed");
    });
  });
});

describe("delegated task read query", () => {
  const task = (
    id: string,
    status: CodexCanonicalDelegatedTaskItem["status"] = "running",
  ): CodexCanonicalDelegatedTaskItem => ({
    type: "delegatedTask",
    id,
    taskId: `task-${id}`,
    title: `Task ${id}`,
    ownerRunId: "one",
    childThreadId: `child-${id}`,
    providerInstanceId: "codex",
    agentKind: "codex",
    prompt: "Review the implementation",
    summary: null,
    status,
  });

  describe("delegated task group read query", () => {
    test("observes every grouped task while ignoring unrelated streaming text", () => {
      const { owner } = timelineOwnerFixture(
        { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null },
        ["first", "second", "text"].map((id) => ({ type: "plan", id, text: id })),
        { status: "inProgress", completedAt: null },
      );
      const retain = owner.subscribeStructure(() => {});
      const publish = (value: CodexCanonicalDelegatedTaskItem) =>
        owner.applyEvent({
          type: "changes",
          changes: [
            { type: "item", key: { ...owner.key, entityKey: "turn:one", itemId: value.id }, value },
          ],
        });
      publish(task("first"));
      publish(task("second"));
      const entries = ["first", "second"].map((id) => owner.readProjectedItem("turn:one", id, id)!);
      const query = createDelegatedTaskReadQuery(owner, "turn:one", entries);
      const initial = query.read();
      const listener = vi.fn();
      const release = query.subscribe(listener);
      const fullTurnRead = vi.spyOn(owner, "readTurn");
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "item",
            key: { ...owner.key, entityKey: "turn:one", itemId: "text" },
            value: { type: "plan", id: "text", text: "streamed" },
          },
        ],
      });
      expect(listener).not.toHaveBeenCalled();
      expect(query.read()).toBe(initial);
      publish(task("second", "failed"));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(query.read().map((entry) => entry.delegatedTask?.status)).toEqual([
        "running",
        "failed",
      ]);
      expect(query.read()[0]).toBe(initial[0]);
      expect(query.read()).toBe(query.read());
      expect(fullTurnRead).not.toHaveBeenCalled();
      release();
      publish(task("first", "completed"));
      expect(listener).toHaveBeenCalledTimes(1);
      retain();
    });
  });
});
