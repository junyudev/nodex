import { describe, expect, test } from "vite-plus/test";

import type { EffectiveDatabaseView } from "../../../../shared/database-kernel";
import type { DatabaseListWindowSnapshot } from "../../../../shared/database-views";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import {
  createDatabaseListWindowStoreRegistry,
  mergeDatabaseListWindow,
  type DatabaseListWindowState,
} from "./use-database-list-window";

const snapshot = (input: {
  readonly rows: readonly { readonly occurrenceKey: string }[];
  readonly windowStart: number;
  readonly commitSeq?: number;
  readonly storeEpoch?: string;
}): DatabaseListWindowSnapshot => ({
  projectId: "project-1",
  libraryId: "library-1",
  databaseId: "database-1",
  dataSourceId: "source-1",
  viewId: "view-1",
  storeEpoch: input.storeEpoch ?? "epoch-1",
  commitSeq: input.commitSeq ?? 4,
  authorization: {} as DatabaseListWindowSnapshot["authorization"],
  projection: {
    scopeKey: "scope-1",
    schemaVersion: 1,
    revision: input.commitSeq ?? 4,
    coveredCommitSeq: input.commitSeq ?? 4,
    effectHash: null,
  },
  nextCursor: "next",
  rows: input.rows.map((row) => ({
    kind: "group" as const,
    occurrenceKey: row.occurrenceKey,
    groupKey: row.occurrenceKey,
    totalOccurrenceCount: 1,
  })),
  groups: [],
  totalProjectionRowCount: 3,
  totalOccurrenceCount: 2,
  totalModelCount: 2,
  windowStart: input.windowStart,
  windowEnd: input.windowStart + input.rows.length,
  isComplete: false,
});

const state = (first: DatabaseListWindowSnapshot): DatabaseListWindowState => ({
  active: true,
  storeEpoch: first.storeEpoch,
  commitSeq: first.commitSeq,
  projection: first.projection,
  rows: first.rows,
  groups: first.groups,
  totalProjectionRowCount: first.totalProjectionRowCount,
  totalOccurrenceCount: first.totalOccurrenceCount,
  totalModelCount: first.totalModelCount,
  nextCursor: first.nextCursor,
  isComplete: first.isComplete,
  loading: false,
  loadingMore: true,
  error: null,
});

const effective: EffectiveDatabaseView = {
  layout: "list",
  rules: {
    propertyFilters: [],
    advancedFilter: null,
    sorts: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
  },
  presentation: {
    conditionalColors: [],
    group: null,
    subgroup: null,
    groupDirection: "asc",
    completion: { range: "all", orderByRecency: false },
    hierarchy: { showSubPages: true, nestedSubPages: true },
    display: { fields: [], propertyOrder: [], showEmptyGroups: false },
  },
};

const model = (commitSeq: number, storeEpoch = "epoch-1"): DatabaseViewRenderModel =>
  ({
    libraryId: "library-1",
    accessContext: { kind: "project", projectId: "project-1" },
    databaseViewId: "view-1",
    databaseId: "database-1",
    dataSourceId: "source-1",
    storeEpoch,
    commitSeq,
    authorization: {},
  }) as unknown as DatabaseViewRenderModel;

const waitForStore = async (): Promise<void> => {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
};

describe("Database List window stitching", () => {
  test("appends a continuous same-revision window", () => {
    const first = snapshot({ rows: [{ occurrenceKey: "one" }], windowStart: 0 });
    const next = snapshot({ rows: [{ occurrenceKey: "two" }], windowStart: 1 });

    expect(mergeDatabaseListWindow(state(first), first, next)).toMatchObject({
      kind: "merged",
      state: {
        rows: [{ occurrenceKey: "one" }, { occurrenceKey: "two" }],
        loadingMore: false,
      },
    });
  });

  test("requests a clean restart for gaps, duplicates, or projection changes", () => {
    const first = snapshot({ rows: [{ occurrenceKey: "one" }], windowStart: 0 });
    expect(
      mergeDatabaseListWindow(
        state(first),
        first,
        snapshot({ rows: [{ occurrenceKey: "two" }], windowStart: 2 }),
      ),
    ).toEqual({ kind: "restart" });
    expect(
      mergeDatabaseListWindow(
        state(first),
        first,
        snapshot({ rows: [{ occurrenceKey: "one" }], windowStart: 1 }),
      ),
    ).toEqual({ kind: "restart" });
    expect(
      mergeDatabaseListWindow(
        state(first),
        first,
        snapshot({ rows: [{ occurrenceKey: "two" }], windowStart: 1, commitSeq: 5 }),
      ),
    ).toEqual({ kind: "restart" });
  });

  test("atomically replaces retained rows when an active List advances", async () => {
    let resolveReplacement!: (value: DatabaseListWindowSnapshot) => void;
    const replacement = new Promise<DatabaseListWindowSnapshot>((resolve) => {
      resolveReplacement = resolve;
    });
    const requestOverridesHaveLayout: boolean[] = [];
    const registry = createDatabaseListWindowStoreRegistry({
      readWindow: async (request) => {
        requestOverridesHaveLayout.push(
          request.input.preferencesOverride !== undefined &&
            request.input.preferencesOverride !== null &&
            "layout" in request.input.preferencesOverride.presentationOverride,
        );
        if (requestOverridesHaveLayout.length === 1) {
          return snapshot({
            rows: [{ occurrenceKey: "stable-old-order" }],
            windowStart: 0,
            commitSeq: 4,
          });
        }
        return await replacement;
      },
    });
    const store = registry.getStore(model(4));
    const unsubscribe = store.subscribe(() => undefined);
    store.setRequest(model(4), effective);
    await waitForStore();

    expect(store.getSnapshot()).toMatchObject({
      active: true,
      loading: false,
      rows: [{ occurrenceKey: "stable-old-order" }],
    });

    const sameStore = registry.getStore(model(5));
    expect(sameStore).toBe(store);
    sameStore.setRequest(model(5), effective);

    expect(sameStore.getSnapshot()).toMatchObject({
      active: true,
      loading: true,
      rows: [{ occurrenceKey: "stable-old-order" }],
    });
    expect(requestOverridesHaveLayout.at(-1)).toBe(false);

    resolveReplacement(
      snapshot({
        rows: [{ occurrenceKey: "stable-new-order" }],
        windowStart: 0,
        commitSeq: 5,
      }),
    );
    await waitForStore();

    expect(sameStore.getSnapshot()).toMatchObject({
      active: true,
      loading: false,
      rows: [{ occurrenceKey: "stable-new-order" }],
    });

    sameStore.setRequest(model(4), effective);
    expect(requestOverridesHaveLayout).toHaveLength(2);
    expect(sameStore.getSnapshot().rows).toMatchObject([{ occurrenceKey: "stable-new-order" }]);
    unsubscribe();
  });

  test("retains the accepted List order when a background replacement fails", async () => {
    let requestCount = 0;
    const registry = createDatabaseListWindowStoreRegistry({
      readWindow: async () => {
        requestCount += 1;
        if (requestCount > 1) throw new Error("unavailable");
        return snapshot({
          rows: [{ occurrenceKey: "accepted-order" }],
          windowStart: 0,
          commitSeq: 4,
        });
      },
    });
    const store = registry.getStore(model(4));
    const unsubscribe = store.subscribe(() => undefined);
    store.setRequest(model(4), effective);
    await waitForStore();

    store.setRequest(model(5), effective);
    await waitForStore();

    expect(store.getSnapshot()).toMatchObject({
      active: true,
      loading: false,
      error: "Couldn’t load the authoritative List window.",
      rows: [{ occurrenceKey: "accepted-order" }],
    });
    unsubscribe();
  });

  test("revalidates the first window before a semantic conflict retry", async () => {
    let requestCount = 0;
    const registry = createDatabaseListWindowStoreRegistry({
      readWindow: async () => {
        requestCount += 1;
        return snapshot({
          rows: [{ occurrenceKey: requestCount === 1 ? "stale" : "rebased" }],
          windowStart: 0,
          commitSeq: requestCount === 1 ? 4 : 5,
        });
      },
    });
    const store = registry.getStore(model(4));
    const unsubscribe = store.subscribe(() => undefined);
    store.setRequest(model(4), effective);
    await waitForStore();

    await expect(store.refresh()).resolves.toMatchObject({
      active: true,
      loading: false,
      commitSeq: 5,
      rows: [{ occurrenceKey: "rebased" }],
    });
    expect(requestCount).toBe(2);
    unsubscribe();
  });

  test("does not read an inactive List and activates only its latest coordinate", async () => {
    const requestCommitSeqs: number[] = [];
    const registry = createDatabaseListWindowStoreRegistry({
      readWindow: async (request) => {
        const commitSeq = request.input.minimumCommitCursor?.commitSeq ?? -1;
        requestCommitSeqs.push(commitSeq);
        return snapshot({
          rows: [{ occurrenceKey: "latest" }],
          windowStart: 0,
          commitSeq,
        });
      },
    });
    const store = registry.getStore(model(1));
    for (let commitSeq = 1; commitSeq <= 100; commitSeq += 1) {
      store.setRequest(model(commitSeq), effective);
    }
    await waitForStore();
    expect(requestCommitSeqs).toEqual([]);

    const unsubscribe = store.subscribe(() => undefined);
    await waitForStore();

    expect(requestCommitSeqs).toEqual([100]);
    expect(store.getSnapshot().rows).toMatchObject([{ occurrenceKey: "latest" }]);
    unsubscribe();
  });

  test("keeps rapid first-window replacements single-flight and reads only the latest target", async () => {
    const pending: Array<(value: DatabaseListWindowSnapshot) => void> = [];
    let requestCount = 0;
    let activeReads = 0;
    let maxActiveReads = 0;
    const registry = createDatabaseListWindowStoreRegistry({
      readWindow: async () => {
        requestCount += 1;
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        return await new Promise<DatabaseListWindowSnapshot>((resolve) => {
          pending.push((value) => {
            activeReads -= 1;
            resolve(value);
          });
        });
      },
    });
    const store = registry.getStore(model(1));
    const unsubscribe = store.subscribe(() => undefined);
    store.setRequest(model(1), effective);
    await Promise.resolve();

    for (let commitSeq = 2; commitSeq <= 100; commitSeq += 1) {
      store.setRequest(model(commitSeq), effective);
    }
    expect(requestCount).toBe(1);
    expect(maxActiveReads).toBe(1);

    pending.shift()?.(
      snapshot({
        rows: [{ occurrenceKey: "obsolete" }],
        windowStart: 0,
        commitSeq: 1,
      }),
    );
    await waitForStore();
    expect(requestCount).toBe(2);
    expect(maxActiveReads).toBe(1);

    pending.shift()?.(
      snapshot({
        rows: [{ occurrenceKey: "latest" }],
        windowStart: 0,
        commitSeq: 100,
      }),
    );
    await waitForStore();

    expect(requestCount).toBe(2);
    expect(maxActiveReads).toBe(1);
    expect(store.getSnapshot()).toMatchObject({
      loading: false,
      rows: [{ occurrenceKey: "latest" }],
    });
    unsubscribe();
  });

  test("hard-fences retained List rows across a Store epoch replacement", async () => {
    let resolveReplacement!: (value: DatabaseListWindowSnapshot) => void;
    const replacement = new Promise<DatabaseListWindowSnapshot>((resolve) => {
      resolveReplacement = resolve;
    });
    let requestCount = 0;
    const registry = createDatabaseListWindowStoreRegistry({
      readWindow: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return snapshot({
            rows: [{ occurrenceKey: "old-epoch-row" }],
            windowStart: 0,
          });
        }
        return await replacement;
      },
    });
    const store = registry.getStore(model(4));
    const unsubscribe = store.subscribe(() => undefined);
    store.setRequest(model(4), effective);
    await waitForStore();

    store.setRequest(model(1, "epoch-2"), effective);

    expect(store.getSnapshot()).toMatchObject({
      active: false,
      loading: true,
      rows: [],
    });

    resolveReplacement(
      snapshot({
        rows: [{ occurrenceKey: "new-epoch-row" }],
        windowStart: 0,
        commitSeq: 1,
        storeEpoch: "epoch-2",
      }),
    );
    await waitForStore();

    expect(store.getSnapshot()).toMatchObject({
      active: true,
      loading: false,
      rows: [{ occurrenceKey: "new-epoch-row" }],
    });
    unsubscribe();
  });
});
