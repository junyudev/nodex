import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import type { DatabasePage } from "./types";

const testState = vi.hoisted(() => ({
  snapshot: {
    databaseView: null,
    materializationRenderToken: null,
  } as unknown,
  mutationOutcome: {
    ok: false,
    error: new Error("Core is unavailable"),
  } as unknown,
  setError: vi.fn(),
  setPresentationOverride: vi.fn(),
  markRendered: vi.fn(),
  applyRemoteCard: vi.fn(),
  applyRemoteCardSummary: vi.fn(),
  resolveConflict: vi.fn(),
  refreshBoard: vi.fn(),
  readBoardPage: vi.fn(),
  readCalendarOccurrenceWindow: vi.fn(),
  completePageOccurrence: vi.fn(),
  skipPageOccurrence: vi.fn(),
  updatePageOccurrence: vi.fn(),
  runOptimisticMutation: vi.fn(),
  commitPageLifecycleIntent: vi.fn(),
  commitDatabasePageDrag: vi.fn(),
  commitPageMetadataPatchForBoardWithReceipt: vi.fn(),
}));

vi.mock("./board-store", () => ({
  getBoardProjectStore: () => ({
    subscribe: () => () => undefined,
    getSnapshot: () => testState.snapshot,
    fetchBoard: vi.fn(),
    loadMore: vi.fn(),
    loadMoreGroup: vi.fn(),
    setPresentationOverride: testState.setPresentationOverride,
    markRendered: testState.markRendered,
    setError: testState.setError,
    runOptimisticMutation: testState.runOptimisticMutation,
    applyRemoteCard: testState.applyRemoteCard,
    applyRemoteCardSummary: testState.applyRemoteCardSummary,
    resolveConflict: testState.resolveConflict,
    refreshBoard: testState.refreshBoard,
  }),
}));

vi.mock("./page-occurrence-runtime", () => ({
  readBoardPage: testState.readBoardPage,
  readCalendarOccurrenceWindow: testState.readCalendarOccurrenceWindow,
  completePageOccurrence: testState.completePageOccurrence,
  skipPageOccurrence: testState.skipPageOccurrence,
  updatePageOccurrence: testState.updatePageOccurrence,
}));

vi.mock("./page-lifecycle-runtime", () => ({
  commitPageLifecycleIntent: testState.commitPageLifecycleIntent,
}));

vi.mock("./database-page-drag-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./database-page-drag-runtime")>()),
  commitDatabasePageDrag: testState.commitDatabasePageDrag,
}));

vi.mock("./page-metadata-board-runtime", () => ({
  commitPageMetadataPatchForBoardWithReceipt: testState.commitPageMetadataPatchForBoardWithReceipt,
}));

import { useBoard } from "./use-board";

const page: DatabasePage = {
  id: "0198a4f1-b850-7000-8000-000000000001",
  pageKey: null,
  status: "plan",
  archived: false,
  title: "Created Page",
  richTitle: plainTextToPortableRichText("Created Page"),
  description: "",
  tags: [],
  created: new Date("2026-08-08T00:00:00.000Z"),
  order: 0,
};

describe("useBoard createPage result", () => {
  beforeEach(() => {
    testState.snapshot = { databaseView: null, materializationRenderToken: null };
    testState.mutationOutcome = {
      ok: false,
      error: new Error("Core is unavailable"),
    };
    testState.setError.mockClear();
    testState.setPresentationOverride.mockClear();
    testState.markRendered.mockClear();
    testState.applyRemoteCard.mockClear();
    testState.applyRemoteCardSummary.mockClear();
    testState.resolveConflict.mockClear();
    testState.refreshBoard.mockReset().mockResolvedValue(undefined);
    testState.readBoardPage.mockReset();
    testState.readCalendarOccurrenceWindow.mockReset();
    testState.completePageOccurrence.mockReset();
    testState.skipPageOccurrence.mockReset();
    testState.updatePageOccurrence.mockReset();
    testState.commitPageLifecycleIntent.mockReset();
    testState.commitDatabasePageDrag.mockReset();
    testState.commitPageMetadataPatchForBoardWithReceipt.mockReset();
    testState.runOptimisticMutation
      .mockReset()
      .mockImplementation(async () => testState.mutationOutcome);
  });

  test("returns the committed Page on success", async () => {
    testState.mutationOutcome = {
      ok: true,
      result: {
        receipt: { storeEpoch: "epoch-test", commitSeq: 2 },
        boardProjection: page,
      },
    };
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));

    let createResult: Awaited<ReturnType<typeof result.current.createPage>> | undefined;
    await act(async () => {
      createResult = await result.current.createPage("plan", {
        title: "Created Page",
      });
    });

    expect(createResult).toEqual({ status: "created", page });
    expect(testState.applyRemoteCard).not.toHaveBeenCalled();
  });

  test("settles canonical materialization only after the subscribed snapshot commits", () => {
    testState.snapshot = {
      databaseView: null,
      materializationRenderToken: 17,
    };

    renderHook(() => useBoard({ projectId: "project-test" }));

    expect(testState.markRendered).toHaveBeenCalledWith(17);
  });

  test("does not settle a retained snapshot for a disabled consumer", () => {
    testState.snapshot = {
      databaseView: null,
      materializationRenderToken: 17,
    };

    renderHook(() => useBoard({ projectId: "project-test", enabled: false }));

    expect(testState.markRendered).not.toHaveBeenCalled();
  });

  test("does not overwrite a retained View presentation before preference hydration", () => {
    renderHook(() =>
      useBoard({
        projectId: "project-test",
        databaseViewId: "view-test",
        presentationOverrideReady: false,
      }),
    );

    expect(testState.setPresentationOverride).not.toHaveBeenCalled();
  });

  test("does not let a non-owner overwrite a shared View presentation", () => {
    renderHook(() =>
      useBoard({
        projectId: "project-test",
        databaseViewId: "view-test",
      }),
    );

    expect(testState.setPresentationOverride).not.toHaveBeenCalled();
  });

  test("lets the presentation owner explicitly restore the durable View", () => {
    renderHook(() =>
      useBoard({
        projectId: "project-test",
        databaseViewId: "view-test",
        presentationOverride: null,
      }),
    );

    expect(testState.setPresentationOverride).toHaveBeenCalledWith(null);
  });

  test("hands off the projection coordinate synchronously before persistence", () => {
    const { result } = renderHook(() =>
      useBoard({
        projectId: "project-test",
        databaseViewId: "view-test",
      }),
    );

    act(() => result.current.setPresentationOverride({ group: null }));

    expect(testState.setPresentationOverride).toHaveBeenCalledWith({
      group: null,
    });
  });

  test("preserves the optimistic mutation error for the modal", async () => {
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));

    let createResult: Awaited<ReturnType<typeof result.current.createPage>> | undefined;
    await act(async () => {
      createResult = await result.current.createPage("plan", {
        title: "Created Page",
      });
    });

    expect(createResult).toEqual({
      status: "error",
      error: "Core is unavailable",
    });
  });

  test("keeps a plain Page detail read out of View-scoped Board authority", async () => {
    testState.readBoardPage.mockResolvedValue(page);
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));

    let loaded: DatabasePage | null | undefined;
    await act(async () => {
      loaded = await result.current.getPage(page.id);
    });

    expect(loaded).toEqual(page);
    expect(testState.applyRemoteCard).not.toHaveBeenCalled();
  });

  test("returns the selected View read-only reason before mutation", async () => {
    testState.snapshot = {
      databaseView: {
        readOnlyReason: "Grouping is not writable",
      },
    };
    const { result } = renderHook(() =>
      useBoard({
        projectId: "project-test",
        databaseViewId: "view-test",
      }),
    );

    let createResult: Awaited<ReturnType<typeof result.current.createPage>> | undefined;
    await act(async () => {
      createResult = await result.current.createPage("plan", {
        title: "Created Page",
      });
    });

    expect(createResult).toEqual({
      status: "error",
      error: "Grouping is not writable",
    });
    expect(testState.setError).toHaveBeenCalledWith("Grouping is not writable");
  });

  test("routes a resolved occurrence rejection through optimistic rollback", async () => {
    testState.completePageOccurrence.mockResolvedValue({
      success: false,
      error: "Page is not scheduled",
    });
    let remoteDisposition: "unobserved" | "acknowledged" | "rejected" = "unobserved";
    testState.runOptimisticMutation.mockImplementationOnce(async (options) => {
      try {
        const result = await options.runRemote();
        remoteDisposition = "acknowledged";
        return { ok: true, result };
      } catch (error) {
        remoteDisposition = "rejected";
        return { ok: false, error };
      }
    });
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));

    let completed: boolean | undefined;
    await act(async () => {
      completed = await result.current.completeOccurrence({
        pageId: "page-1",
        occurrenceStart: new Date("2026-08-09T00:00:00.000Z"),
        source: "calendar",
      });
    });

    expect(completed).toBe(false);
    expect(remoteDisposition).toBe("rejected");
    expect(testState.completePageOccurrence).toHaveBeenCalledWith(
      "project-test",
      expect.objectContaining({ pageId: "page-1" }),
      undefined,
    );
  });

  test("threads the occurrence commit cursor through every optimistic action", async () => {
    const committed = {
      success: true,
      commitCursor: { storeEpoch: "epoch-occurrence", commitSeq: 19 },
    };
    testState.completePageOccurrence.mockResolvedValue(committed);
    testState.skipPageOccurrence.mockResolvedValue(committed);
    testState.updatePageOccurrence.mockResolvedValue(committed);
    const cursors: unknown[] = [];
    testState.runOptimisticMutation.mockImplementation(async (options) => {
      const acknowledged = await options.runRemote();
      cursors.push(options.getCommitCursor?.(acknowledged));
      return { ok: true, result: acknowledged };
    });
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));
    const occurrenceStart = new Date("2026-08-09T00:00:00.000Z");
    let outcomes: boolean[] = [];

    await act(async () => {
      outcomes = [
        await result.current.completeOccurrence({
          pageId: "page-1",
          occurrenceStart,
          source: "calendar",
        }),
        await result.current.skipOccurrence({
          pageId: "page-1",
          occurrenceStart,
          source: "calendar",
        }),
        await result.current.updateOccurrence({
          pageId: "page-1",
          occurrenceStart,
          source: "calendar",
          scope: "all",
          updates: { scheduledStart: new Date("2026-08-09T01:00:00.000Z") },
        }),
      ];
    });

    expect(outcomes).toEqual([true, true, true]);
    expect(cursors).toEqual([
      committed.commitCursor,
      committed.commitCursor,
      committed.commitCursor,
    ]);
    expect(testState.completePageOccurrence).toHaveBeenCalledOnce();
    expect(testState.skipPageOccurrence).toHaveBeenCalledOnce();
    expect(testState.updatePageOccurrence).toHaveBeenCalledOnce();
  });

  test("keeps the Page lifecycle receipt as the delete acknowledgement", async () => {
    const committed = {
      receipt: {
        lifecycle: "deleted",
        storeEpoch: "epoch-test",
        commitSeq: 17,
      },
      boardProjection: null,
    };
    testState.commitPageLifecycleIntent.mockResolvedValue(committed);
    let acknowledged: unknown;
    let commitCursor: { storeEpoch: string; commitSeq: number } | null | undefined;
    testState.runOptimisticMutation.mockImplementationOnce(async (options) => {
      acknowledged = await options.runRemote();
      commitCursor = options.getCommitCursor?.(acknowledged);
      return { ok: true, result: acknowledged };
    });
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await result.current.deletePage("plan", "page-1");
    });

    expect(deleted).toBe(true);
    expect(acknowledged).toBe(committed);
    expect(commitCursor).toEqual({ storeEpoch: "epoch-test", commitSeq: 17 });
    expect(testState.commitPageLifecycleIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "delete",
        projectId: "project-test",
        pageId: "page-1",
      }),
    );
  });

  test("threads the Database receipt commit floor through a Page drag", async () => {
    testState.snapshot = {
      databaseView: {
        accessContext: { kind: "project", projectId: "project-test" },
        libraryId: "library-test",
        storeEpoch: "epoch-test",
        commitSeq: 3,
        query: {},
      },
    };
    const receipt = { storeEpoch: "epoch-test", commitSeq: 23 };
    testState.commitDatabasePageDrag.mockResolvedValue(receipt);
    let commitCursor: { storeEpoch: string; commitSeq: number } | null | undefined;
    testState.runOptimisticMutation.mockImplementationOnce(async (options) => {
      const acknowledged = await options.runRemote();
      commitCursor = options.getCommitCursor?.(acknowledged);
      return { ok: true, result: acknowledged };
    });
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));

    let moved: boolean | undefined;
    await act(async () => {
      moved = await result.current.movePage({
        pageId: "page-1",
        fromStatus: "plan",
        toStatus: "ship",
      });
    });

    expect(moved).toBe(true);
    expect(commitCursor).toEqual({ storeEpoch: "epoch-test", commitSeq: 23 });
    expect(testState.commitDatabasePageDrag).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-test",
        move: expect.objectContaining({ pageId: "page-1", toStatus: "ship" }),
      }),
    );
  });

  test("keeps a metadata overlay until its durable commit cursor is covered", async () => {
    const committed = {
      result: {
        status: "updated",
        projectId: "project-test",
        pageId: "page-1",
        changedFields: ["priority"],
        didMutate: true,
      },
      commitCursor: { storeEpoch: "epoch-test", commitSeq: 29 },
    };
    testState.commitPageMetadataPatchForBoardWithReceipt.mockResolvedValue(committed);
    let commitCursor: { storeEpoch: string; commitSeq: number } | null | undefined;
    testState.runOptimisticMutation.mockImplementationOnce(async (options) => {
      const acknowledged = await options.runRemote();
      commitCursor = options.getCommitCursor?.(acknowledged);
      return { ok: true, result: acknowledged };
    });
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));

    let updated: Awaited<ReturnType<typeof result.current.updatePage>> | undefined;
    await act(async () => {
      updated = await result.current.updatePage("plan", "page-1", {
        priority: "p1-high",
      });
    });

    expect(updated).toEqual(committed.result);
    expect(commitCursor).toEqual({ storeEpoch: "epoch-test", commitSeq: 29 });
    expect(testState.applyRemoteCardSummary).not.toHaveBeenCalled();
  });

  test("refreshes metadata conflicts without injecting an unscoped Board card", async () => {
    const committed = {
      result: { status: "conflict", page },
      commitCursor: null,
    };
    testState.commitPageMetadataPatchForBoardWithReceipt.mockResolvedValue(committed);
    testState.runOptimisticMutation.mockImplementationOnce(async (options) => ({
      ok: true,
      result: await options.runRemote(),
    }));
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));

    let updated: Awaited<ReturnType<typeof result.current.updatePage>> | undefined;
    await act(async () => {
      updated = await result.current.updatePage("plan", page.id, {
        priority: "p1-high",
      });
    });

    expect(updated).toEqual(committed.result);
    expect(testState.applyRemoteCard).not.toHaveBeenCalled();
    expect(testState.resolveConflict).toHaveBeenCalled();
    expect(testState.refreshBoard).toHaveBeenCalledOnce();
  });

  test("retires a metadata overlay when canonical authority reports not found", async () => {
    const committed = {
      result: { status: "not_found" },
      commitCursor: null,
    } as const;
    testState.commitPageMetadataPatchForBoardWithReceipt.mockResolvedValue(committed);
    testState.runOptimisticMutation.mockImplementationOnce(async (options) => ({
      ok: true,
      result: await options.runRemote(),
    }));
    const { result } = renderHook(() => useBoard({ projectId: "project-test" }));

    let updated: Awaited<ReturnType<typeof result.current.updatePage>> | undefined;
    await act(async () => {
      updated = await result.current.updatePage("plan", page.id, {
        priority: "p1-high",
      });
    });

    expect(updated).toEqual({ status: "not_found" });
    expect(testState.resolveConflict).toHaveBeenCalled();
    expect(testState.refreshBoard).toHaveBeenCalledOnce();
  });
});
