import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import type { BoardSummary, DatabasePage } from "./types";

const state = vi.hoisted(() => ({
  snapshot: { databaseView: null } as {
    databaseView: null | {
      query: { properties: DataSourcePropertyRecordV2[] };
    };
  },
  setError: vi.fn(),
  fetchBoard: vi.fn(),
  runOptimisticMutation: vi.fn(),
  setDatabaseRowDetail: vi.fn(),
  commitPageLifecycleIntent: vi.fn(),
}));

vi.mock("./board-store", () => ({
  getBoardProjectStore: () => ({
    getSnapshot: () => state.snapshot,
    setError: state.setError,
    fetchBoard: state.fetchBoard,
    runOptimisticMutation: state.runOptimisticMutation,
  }),
}));

vi.mock("./database-row-detail-store", () => ({
  setDatabaseRowDetail: state.setDatabaseRowDetail,
}));

vi.mock("./page-lifecycle-runtime", () => ({
  commitPageLifecycleIntent: state.commitPageLifecycleIntent,
}));

import { createBoardPage } from "./board-page-create-command";

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

describe("createBoardPage", () => {
  beforeEach(() => {
    state.snapshot = {
      databaseView: {
        query: { properties: [] },
      },
    };
    state.setError.mockReset();
    state.fetchBoard.mockReset();
    state.runOptimisticMutation
      .mockReset()
      .mockImplementation(async (options: { runRemote: () => Promise<unknown> }) => ({
        ok: true,
        result: await options.runRemote(),
      }));
    state.setDatabaseRowDetail.mockReset();
    state.commitPageLifecycleIntent.mockReset().mockResolvedValue({
      receipt: {
        storeEpoch: "epoch-test",
        commitSeq: 42,
        metadataRevision: 1,
        committedAt: "2026-08-08T00:00:00.000Z",
      },
      boardProjection: page,
    });
  });

  test("preserves the optimistic-to-canonical create boundary without a mounted Board", async () => {
    const result = await createBoardPage({
      projectId: "project-test",
      databaseViewId: "view-test",
      clientSessionId: "session-test",
      status: "plan",
      input: {
        title: "Created Page",
        priority: "p1-high",
        estimate: "m",
        tagOptions: [{ optionId: "o_AAAAAAAA", name: "Product" }],
      },
      placement: "top",
    });

    expect(result).toEqual({ status: "created", page });
    expect(state.commitPageLifecycleIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create",
        projectId: "project-test",
        clientSessionId: "session-test",
        status: "plan",
        placement: "top",
        input: expect.objectContaining({
          title: "Created Page",
          priority: undefined,
          estimate: undefined,
          tagOptions: [],
        }),
      }),
    );
    const optimisticMutation = state.runOptimisticMutation.mock.calls[0]?.[0] as {
      apply: (board: BoardSummary) => BoardSummary;
      getCommitCursor: (result: { receipt: { storeEpoch: string; commitSeq: number } }) => {
        storeEpoch: string;
        commitSeq: number;
      };
    };
    const optimisticBoard = optimisticMutation.apply({
      columns: [{ id: "plan", name: "Plan", cards: [] }],
    });
    expect(optimisticBoard.columns[0]?.cards[0]?.status).toBe("plan");
    expect(
      optimisticMutation.getCommitCursor({
        receipt: { storeEpoch: "epoch-test", commitSeq: 42 },
      }),
    ).toEqual({ storeEpoch: "epoch-test", commitSeq: 42 });
    expect(state.setDatabaseRowDetail).toHaveBeenCalledWith("project-test", page);
  });

  test("reports durable create success when the best-effort row read is delayed", async () => {
    state.commitPageLifecycleIntent.mockResolvedValue({
      receipt: {
        storeEpoch: "epoch-test",
        commitSeq: 43,
        metadataRevision: 7,
        committedAt: "2026-08-08T01:00:00.000Z",
      },
      boardProjection: null,
    });

    const result = await createBoardPage({
      projectId: "project-test",
      databaseViewId: "view-test",
      status: "plan",
      input: { title: "Durably created", description: "Body" },
      placement: "top",
    });

    expect(result).toMatchObject({
      status: "created",
      page: {
        title: "Durably created",
        description: "Body",
        revision: 7,
        created: new Date("2026-08-08T01:00:00.000Z"),
      },
    });
    expect(state.setDatabaseRowDetail).not.toHaveBeenCalled();
  });

  test("does not repopulate detail authority after its Store epoch was fenced", async () => {
    state.runOptimisticMutation.mockImplementationOnce(
      async (options: { runRemote: () => Promise<unknown> }) => ({
        ok: true,
        result: await options.runRemote(),
        superseded: true,
      }),
    );

    const result = await createBoardPage({
      projectId: "project-test",
      databaseViewId: "view-test",
      status: "plan",
      input: { title: "Created before reset" },
    });

    expect(result).toEqual({ status: "created", page });
    expect(state.setDatabaseRowDetail).not.toHaveBeenCalled();
  });

  test("loads and rechecks the exact View before rejecting a stale target", async () => {
    state.snapshot = { databaseView: null };
    state.fetchBoard.mockImplementation(async () => {
      return true;
    });

    const result = await createBoardPage({
      projectId: "project-test",
      databaseViewId: "view-test",
      status: "plan",
      input: { title: "Created Page" },
    });

    expect(result).toEqual({
      status: "error",
      error: "The selected Database View is not ready for writes",
    });
    expect(state.fetchBoard).toHaveBeenCalledOnce();
    expect(state.runOptimisticMutation).not.toHaveBeenCalled();
  });
});
