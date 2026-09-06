import { describe, expect, test, vi } from "vite-plus/test";
import * as Y from "yjs";
import * as historyOwner from "./surface-history/owner";
import { getPageTitleInteractionHistory } from "./page-title-interaction-history";
import {
  acquireContentInteractionHistory,
  type ContentInteractionHistoryScope,
} from "./content-interaction-history";

const scope: ContentInteractionHistoryScope = {
  libraryId: "title-test-library",
  accessContext: { kind: "library" },
  storeEpoch: "title-test-epoch",
};

describe("Page title interaction history", () => {
  test("bounds constant-length grouped replacements by cumulative native updates and keeps fresh edits replayable after trimming", async () => {
    const createHistory = historyOwner.createInteractionHistory;
    const factory = vi
      .spyOn(historyOwner, "createInteractionHistory")
      .mockImplementationOnce((options) =>
        createHistory({ ...options, limits: { ...options.limits, maxBytes: 1024 } }),
      );
    const document = new Y.Doc();
    const title = document.getText("title");
    title.insert(0, "a".repeat(64));
    const history = getPageTitleInteractionHistory(title);
    factory.mockRestore();
    const origin = {};
    const release = history.retainOrigin(origin);
    try {
      let trimmed = false;
      for (let index = 0; index < 40; index++) {
        document.transact(() => {
          title.delete(0, title.length);
          title.insert(0, (index % 2 === 0 ? "b" : "c").repeat(64));
        }, origin);
        expect(title.length).toBe(64);
        if (history.controls.snapshot().undo.status !== "empty") continue;
        trimmed = true;
        break;
      }
      expect(trimmed).toBe(true);
      expect(history.controls.retained()).toHaveLength(0);
      expect((await history.controls.request("undo").result).status).toBe("noop");
      const before = title.toString();
      document.transact(() => title.insert(title.length, "!"), origin);
      expect((await history.controls.request("undo").result).status).toBe("committed");
      expect(title.toString()).toBe(before);
      expect((await history.controls.request("redo").result).status).toBe("committed");
      expect(title.toString()).toBe(`${before}!`);
    } finally {
      factory.mockRestore();
      release();
      document.destroy();
    }
  });

  test("immediately oversized captures leave no reachable index and do not block a later small edit", async () => {
    const createHistory = historyOwner.createInteractionHistory;
    const factory = vi
      .spyOn(historyOwner, "createInteractionHistory")
      .mockImplementationOnce((options) =>
        createHistory({ ...options, limits: { ...options.limits, maxBytes: 512 } }),
      );
    const document = new Y.Doc();
    const title = document.getText("title");
    const history = getPageTitleInteractionHistory(title);
    factory.mockRestore();
    const origin = {};
    const release = history.retainOrigin(origin);
    try {
      document.transact(() => title.insert(0, "a".repeat(300)), origin);
      expect(history.controls.retained()).toHaveLength(0);
      document.transact(() => title.delete(0, title.length), origin);
      expect(history.controls.retained()).toHaveLength(0);
      document.transact(() => title.insert(0, "small"), origin);
      expect(history.controls.retained()).toHaveLength(1);
      await history.controls.request("undo").result;
      expect(title.toString()).toBe("");
      await history.controls.request("redo").result;
      expect(title.toString()).toBe("small");
    } finally {
      factory.mockRestore();
      release();
      document.destroy();
    }
  });
  test("orders captures across titles and cuts off native merging before another participant edits", async () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    const a = first.getText("title");
    const b = second.getText("title");
    const aHistory = getPageTitleInteractionHistory(a, scope);
    const bHistory = getPageTitleInteractionHistory(b, scope);
    const aOrigin = {};
    const bOrigin = {};
    const releaseA = aHistory.retainOrigin(aOrigin);
    const releaseB = bHistory.retainOrigin(bOrigin);
    try {
      first.transact(() => a.insert(0, "A"), aOrigin);
      second.transact(() => b.insert(0, "B"), bOrigin);
      first.transact(() => a.insert(1, "C"), aOrigin);
      expect((await aHistory.controls.request("undo").result).status).toBe("committed");
      expect(a.toString()).toBe("A");
      expect(b.toString()).toBe("B");
      await aHistory.controls.request("undo").result;
      expect(b.toString()).toBe("");
      await bHistory.controls.request("undo").result;
      expect(a.toString()).toBe("");
      await bHistory.controls.request("redo").result;
      await aHistory.controls.request("redo").result;
      await bHistory.controls.request("redo").result;
      expect(a.toString()).toBe("AC");
      expect(b.toString()).toBe("B");
      expect((await bHistory.controls.request("redo").result).status).toBe("noop");
    } finally {
      releaseA();
      releaseB();
      first.destroy();
      second.destroy();
    }
  });

  test("shares one title journal across remounted views and excludes remote changes", async () => {
    const document = new Y.Doc();
    const title = document.getText("title");
    const origin = {};
    const history = getPageTitleInteractionHistory(title, scope);
    const release = history.retainOrigin(origin);
    try {
      document.transact(() => title.insert(0, "Local"), origin);
      release();
      const remounted = getPageTitleInteractionHistory(title, scope);
      expect(remounted).toBe(history);
      document.transact(() => title.insert(title.length, " remote"), {});
      await remounted.controls.request("undo").result;
      expect(title.toString()).toBe(" remote");
      await remounted.controls.request("redo").result;
      expect(title.toString()).toBe("Local remote");
    } finally {
      release();
      document.destroy();
    }
  });

  test("isolates access realms and releases the last runtime lease", () => {
    const first = acquireContentInteractionHistory(scope);
    const shared = acquireContentInteractionHistory({ ...scope });
    const project = acquireContentInteractionHistory({
      ...scope,
      accessContext: { kind: "project", projectId: "p" },
    });
    expect(shared.history).toBe(first.history);
    expect(project.history).not.toBe(first.history);
    first.release();
    shared.release();
    first.release();
    const fresh = acquireContentInteractionHistory(scope);
    expect(fresh.history).not.toBe(first.history);
    project.release();
    fresh.release();
  });
});
