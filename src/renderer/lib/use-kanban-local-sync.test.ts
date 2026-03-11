import { describe, expect, test } from "bun:test";
import {
  publishKanbanLocalMutation,
  resetKanbanLocalMutationListenersForTest,
  subscribeKanbanLocalMutation,
} from "./use-kanban-local-sync";

describe("kanban local optimistic mutation sync", () => {
  test("publishes patch mutations to listeners in the same project", () => {
    resetKanbanLocalMutationListenersForTest();
    const sourceInstanceId = Symbol("source");
    const received: string[] = [];

    const unsubscribe = subscribeKanbanLocalMutation("default", (mutation) => {
      if (mutation.type !== "patch") return;
      received.push(`${mutation.columnId}:${mutation.cardId}:${String(mutation.updates.title ?? "")}`);
    });

    publishKanbanLocalMutation("default", {
      type: "patch",
      sourceInstanceId,
      columnId: "backlog",
      cardId: "abc",
      updates: { title: "Updated from projection" },
    });

    expect(received.length).toBe(1);
    expect(received[0]).toBe("backlog:abc:Updated from projection");
    unsubscribe();
  });

  test("does not publish mutations across different projects", () => {
    resetKanbanLocalMutationListenersForTest();
    const sourceInstanceId = Symbol("source");
    let callCount = 0;

    const unsubscribe = subscribeKanbanLocalMutation("default", () => {
      callCount += 1;
    });

    publishKanbanLocalMutation("another-project", {
      type: "patch",
      sourceInstanceId,
      columnId: "backlog",
      cardId: "abc",
      updates: { description: "Should not cross project boundary" },
    });

    expect(callCount).toBe(0);
    unsubscribe();
  });

  test("unsubscribe detaches listener", () => {
    resetKanbanLocalMutationListenersForTest();
    const sourceInstanceId = Symbol("source");
    let callCount = 0;

    const unsubscribe = subscribeKanbanLocalMutation("default", () => {
      callCount += 1;
    });

    unsubscribe();

    publishKanbanLocalMutation("default", {
      type: "refresh",
      sourceInstanceId,
    });

    expect(callCount).toBe(0);
  });
});
