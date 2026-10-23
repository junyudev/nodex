import { describe, expect, test, vi } from "vite-plus/test";
import type { CodexCanonicalDelegatedTaskItem } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { timelineOwnerFixture } from "./normalized-timeline.test-fixtures";
import { createDelegatedTaskReadQuery } from "./delegated-task-read-query";

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
    expect(query.read().map((entry) => entry.delegatedTask?.status)).toEqual(["running", "failed"]);
    expect(query.read()[0]).toBe(initial[0]);
    expect(query.read()).toBe(query.read());
    expect(fullTurnRead).not.toHaveBeenCalled();
    release();
    publish(task("first", "completed"));
    expect(listener).toHaveBeenCalledTimes(1);
    retain();
  });
});
