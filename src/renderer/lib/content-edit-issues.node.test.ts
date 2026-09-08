import { expect, test, vi } from "vite-plus/test";
import { createContentEditIssueRegistry, type ContentEditIssue } from "./content-edit-issues";
import { createContentHistoryIssueSource } from "./content-history-issues";
import { createSurfaceHistory } from "./surface-history/owner";

const scope = {
  libraryId: "library",
  accessContext: { kind: "library" as const },
  storeEpoch: "epoch",
};

test("observation preserves distinct problems in one scope and releases borrowed sources", () => {
  const registry = createContentEditIssueRegistry();
  const first: ContentEditIssue = {
    kind: "history",
    id: "action-a",
    scope,
    location: null,
    title: "Move Pages",
    detail: "Not confirmed",
    actions: [],
  };
  const second = { ...first, id: "action-b" };
  let issues: readonly ContentEditIssue[] = [first, second];
  let notify = () => {};
  const detached = vi.fn();
  const source = {
    getIssues: () => issues,
    subscribe: (listener: () => void) => {
      notify = listener;
      return detached;
    },
  };
  const releaseOne = registry.register(source);
  const releaseTwo = registry.register(source);
  expect(registry.getSnapshot()).toEqual([first, second]);
  const snapshot = registry.getSnapshot();
  notify();
  expect(registry.getSnapshot()).toBe(snapshot);
  issues = [second];
  notify();
  expect(registry.getSnapshot()).toEqual([second]);
  releaseOne();
  expect(detached).not.toHaveBeenCalled();
  releaseTwo();
  expect(detached).toHaveBeenCalledTimes(1);
  expect(registry.getSnapshot()).toEqual([]);
});

test("a live failed replica and its exact retained draft form one issue with live recovery actions", () => {
  const registry = createContentEditIssueRegistry();
  const draft: ContentEditIssue = {
    kind: "draft",
    id: "draft-a",
    scope,
    location: null,
    title: "Draft",
    detail: "Review",
    actions: [],
  };
  const live: ContentEditIssue = {
    ...draft,
    kind: "save",
    title: "Couldn’t save",
    actions: [{ kind: "run", label: "Continue editing", run: vi.fn() }],
  };
  const source = (issue: ContentEditIssue) => ({
    getIssues: () => [issue],
    subscribe: () => () => {},
  });
  const releaseLive = registry.register(source(live));
  const releaseDraft = registry.register(source(draft));
  expect(registry.getSnapshot()).toEqual([live]);
  releaseLive();
  expect(registry.getSnapshot()).toEqual([draft]);
  releaseDraft();
});

test("successful irreversible edits protect the Undo frontier without creating a problem", async () => {
  const history = createSurfaceHistory({
    scopeKey: "test",
    adapter: {
      describe: () => "Change Relation",
      prepare: async (request: number) => ({ kind: "submit", request }),
      prepareInverse: async (request: number) => ({ kind: "submit", request }),
      submit: async (receipt: number) => ({ kind: "committed", receipt }),
      interpret: () => ({ kind: "barrier", reason: "This edit cannot be undone." }),
    },
  });
  try {
    const source = createContentHistoryIssueSource(scope, history);
    await history.execute(1).result;
    expect(history.snapshot().undo.status).toBe("blocked");
    expect((await history.request("undo").result).status).toBe("blocked");
    expect(source.getIssues()).toEqual([]);
  } finally {
    history.close();
  }
});

test("old recovery actions cannot retry or clear a new history generation", async () => {
  const submitted: number[] = [];
  const history = createSurfaceHistory({
    scopeKey: "test",
    adapter: {
      describe: () => "Move Pages",
      prepare: async (request: number) => ({ kind: "submit", request }),
      prepareInverse: async (request: number) => ({ kind: "submit", request }),
      submit: async (request: number) => {
        submitted.push(request);
        return { kind: "unknown", reason: "Reply lost." };
      },
      interpret: (receipt: number) => ({ kind: "reversible", inverse: -receipt }),
    },
  });
  try {
    await history.execute(1).result;
    const source = createContentHistoryIssueSource(scope, history);
    const original = source.getIssues()[0]!;
    history.reset();
    await history.execute(2).result;
    const retry = original.actions.find((action) => action.kind === "run" && !action.confirmation)!;
    const clear = original.actions.find((action) => action.kind === "run" && action.confirmation)!;
    if (retry.kind !== "run" || clear.kind !== "run") throw new Error("Expected recovery actions");
    await retry.run();
    expect(submitted).toEqual([1, 2]);
    expect(() => clear.run()).toThrow("history changed");
    expect(history.attention()).toHaveLength(1);
  } finally {
    history.close();
  }
});
