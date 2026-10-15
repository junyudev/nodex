import { describe, expect, test, vi } from "vite-plus/test";
import type {
  ProjectionDelivery,
  ProjectionImpact,
  ProjectionScope,
  ProjectionStreamMessage,
} from "../../shared/projection-stream";
import { projectionScopeKey } from "../../shared/projection-stream";
import {
  impactMatches,
  type ProjectionInvalidationCause,
  ProjectionInvalidationRegistry,
  projectionEffectMatches,
} from "./projection-invalidation-registry";
import { INTERACTIVE_PROJECTION_REPAIR_BURST } from "./causal-projection-runtime";

const scope: ProjectionScope = {
  kind: "project",
  libraryId: "library-1",
  projectId: "project-1",
};

const impact = (
  overrides: Partial<Extract<ProjectionImpact, { kind: "resources" }>> = {},
): ProjectionImpact => ({
  kind: "resources",
  page_ids: [],
  database_ids: [],
  data_source_ids: [],
  view_ids: [],
  document_heads: [],
  ...overrides,
});

const delivery = (commitSeq: number): ProjectionDelivery => ({
  storeEpoch: "epoch-1",
  commitSeq,
  manifestHash: String(commitSeq).padStart(64, "b").slice(-64),
  operationId: `operation-${commitSeq}`,
  committedAt: "2026-08-06T00:00:00.000Z",
  impact: impact({ page_ids: ["page-1"] }),
  effect: {
    scope: {
      schema_version: 1,
      canonical_key: "scope:page-1",
      scope: {
        kind: "page",
        project_id: "project-1",
        page_id: "page-1",
      },
    },
    baseRevision: commitSeq - 1,
    resultRevision: commitSeq,
    coveredCommitSeq: commitSeq,
    patch: {
      kind: "page_changed",
      projectId: "project-1",
      pageId: "page-1",
    },
    requiresReadAtLeast: true,
    effectHash: String(commitSeq).padStart(64, "a").slice(-64),
  },
});

const effectMessage = (commitSeq: number): ProjectionStreamMessage => ({
  version: 2,
  kind: "effect",
  scope,
  stream: { storeEpoch: "epoch-1", commitSeq },
  delivery: delivery(commitSeq),
});

test("history lifecycle signals do not invalidate unrelated aggregate content projections", () => {
  const base = delivery(1);
  const history: ProjectionDelivery = {
    ...base,
    impact: { kind: "none" },
    effect: {
      ...base.effect,
      scope: {
        ...base.effect.scope,
        scope: { kind: "structural_history", project_id: "project-1" },
      },
      patch: null,
    },
  };
  expect(projectionEffectMatches({ aggregate: true }, history)).toBe(false);
  expect(projectionEffectMatches({ pageIds: ["page-1"] }, history)).toBe(false);
  expect(projectionEffectMatches({ aggregate: true }, base)).toBe(true);
});

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
};

const harness = (effectRepairBurst?: { readonly quietMs: number; readonly maxMs: number }) => {
  const projectionListeners = new Set<(message: ProjectionStreamMessage) => void>();
  const subscribeProjection = vi.fn(
    (_scope: ProjectionScope, listener: (message: ProjectionStreamMessage) => void) => {
      projectionListeners.add(listener);
      return () => projectionListeners.delete(listener);
    },
  );

  return {
    registry: new ProjectionInvalidationRegistry({
      subscribeProjection,
      ...(effectRepairBurst ? { effectRepairBurst } : {}),
    }),
    subscribeProjection,
    publish(message: ProjectionStreamMessage) {
      for (const listener of projectionListeners) listener(message);
    },
    listenerCount: () => projectionListeners.size,
  };
};

describe("ProjectionInvalidationRegistry", () => {
  test("keeps delimiter-bearing Library and Project scope identities distinct", () => {
    expect(
      projectionScopeKey({
        kind: "project",
        libraryId: "library:a",
        projectId: "project",
      }),
    ).not.toBe(
      projectionScopeKey({
        kind: "project",
        libraryId: "library",
        projectId: "a:project",
      }),
    );
  });
  test("matches every impact identity dimension", () => {
    const value = impact({
      page_ids: ["page-1"],
      database_ids: ["database-1"],
      data_source_ids: ["source-1"],
      view_ids: ["view-1"],
      document_heads: [
        {
          page_id: "page-1",
          document_id: "document-1",
          generation: 1,
          head_seq: 2,
        },
      ],
    });
    expect(impactMatches({ pageIds: ["page-1"] }, value)).toBe(true);
    expect(impactMatches({ databaseIds: ["database-1"] }, value)).toBe(true);
    expect(impactMatches({ dataSourceIds: ["source-1"] }, value)).toBe(true);
    expect(impactMatches({ viewIds: ["view-1"] }, value)).toBe(true);
    expect(impactMatches({ documentIds: ["document-1"] }, value)).toBe(true);
    expect(impactMatches({ pageIds: ["other"] }, value)).toBe(false);
  });

  test("separates Database View effects from Page Detail structure", () => {
    const rowDelivery: ProjectionDelivery = {
      ...delivery(2),
      impact: impact({
        page_ids: ["page-c"],
        database_ids: ["database-1"],
        data_source_ids: ["source-1"],
        view_ids: ["view-1"],
      }),
      effect: {
        ...delivery(2).effect,
        scope: {
          schema_version: 1,
          canonical_key: "scope:view-1",
          scope: {
            kind: "database_view",
            project_id: "project-1",
            database_id: "database-1",
            data_source_id: "source-1",
            view_id: "view-1",
          },
        },
        patch: {
          kind: "database_row_remove",
          projectId: "project-1",
          databaseId: "database-1",
          dataSourceId: "source-1",
          viewId: "view-1",
          pageId: "page-c",
          totalRows: 2,
          groupKey: null,
          subgroupKey: null,
          groupTotal: null,
        },
      },
    };
    const dependencies = {
      pageIds: ["page-a"],
      databaseIds: ["database-1"],
      dataSourceIds: ["source-1"],
    };

    expect(projectionEffectMatches(dependencies, rowDelivery)).toBe(false);
    expect(
      projectionEffectMatches(dependencies, {
        ...rowDelivery,
        effect: { ...rowDelivery.effect, patch: null },
      }),
    ).toBe(false);
    expect(
      projectionEffectMatches(dependencies, {
        ...rowDelivery,
        impact: impact({
          page_ids: [],
          database_ids: ["database-1"],
          data_source_ids: ["source-1"],
          view_ids: [],
        }),
        effect: {
          ...rowDelivery.effect,
          scope: {
            schema_version: 1,
            canonical_key: "scope:page-data-source-1",
            scope: {
              kind: "page_detail_data_source",
              project_id: "project-1",
              database_id: "database-1",
              data_source_id: "source-1",
            },
          },
          patch: null,
        },
      }),
    ).toBe(true);
    expect(
      projectionEffectMatches(dependencies, {
        ...rowDelivery,
        impact: impact({
          page_ids: [],
          database_ids: ["database-1"],
          data_source_ids: [],
          view_ids: [],
        }),
        effect: {
          ...rowDelivery.effect,
          scope: {
            schema_version: 1,
            canonical_key: "scope:page-database-1",
            scope: {
              kind: "page_detail_database",
              project_id: "project-1",
              database_id: "database-1",
            },
          },
          patch: null,
        },
      }),
    ).toBe(true);
  });

  test("shares one projection subscription and reference-counts one consumer", async () => {
    const stream = harness();
    let cursor = { storeEpoch: "epoch-1", commitSeq: 0 };
    const first = vi.fn(async (message: ProjectionInvalidationCause) => {
      cursor = message.stream;
    });
    const second = vi.fn();
    const registration = (invalidate: (message: ProjectionInvalidationCause) => void) => ({
      scope,
      consumerKey: "shared",
      getDependencies: () => ({ pageIds: ["page-1"] }),
      getCursor: () => cursor,
      invalidate,
    });
    const releaseFirst = stream.registry.register(registration(first));
    const releaseSecond = stream.registry.register(registration(second));
    stream.publish(effectMessage(1));
    await flush();

    expect(stream.subscribeProjection).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    releaseFirst();
    stream.publish(effectMessage(2));
    await flush();
    expect(second).toHaveBeenCalledOnce();
    releaseSecond();
    expect(stream.listenerCount()).toBe(0);
  });

  test("uses only the initial checkpoint to close the read-subscribe race", async () => {
    const stream = harness();
    const invalidate = vi.fn();
    const fence = vi.fn();
    stream.registry.register({
      scope,
      consumerKey: "query",
      getDependencies: () => ({ pageIds: ["page-1"] }),
      getCursor: () => ({ storeEpoch: "epoch-1", commitSeq: 1 }),
      fence,
      invalidate,
    });
    const checkpoint = (commitSeq: number): ProjectionStreamMessage => ({
      version: 2,
      kind: "checkpoint",
      scope,
      stream: { storeEpoch: "epoch-1", commitSeq },
    });
    stream.publish(checkpoint(2));
    expect(fence).toHaveBeenCalledOnce();
    stream.publish(checkpoint(3));
    await flush();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(fence).toHaveBeenCalledOnce();
  });

  test("replays the latest scope position as a checkpoint for a new consumer", async () => {
    const stream = harness();
    const invalidate = vi.fn();
    stream.registry.register({
      scope,
      consumerKey: "keeper",
      getDependencies: () => ({ aggregate: true }),
      getCursor: () => ({ storeEpoch: "epoch-1", commitSeq: 1 }),
      invalidate: () => undefined,
    });
    stream.publish(effectMessage(2));

    stream.registry.register({
      scope,
      consumerKey: "late-page",
      getDependencies: () => ({ pageIds: ["page-1"] }),
      getCursor: () => null,
      invalidate,
    });
    await flush();

    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate.mock.calls[0]?.[0]).toMatchObject({
      kind: "checkpoint",
      stream: { storeEpoch: "epoch-1", commitSeq: 2 },
    });
  });

  test("coalesces generic invalidations while a canonical read is running", async () => {
    const stream = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cursor = { storeEpoch: "epoch-1", commitSeq: 0 };
    const invalidate = vi.fn(async (message: ProjectionInvalidationCause) => {
      if (invalidate.mock.calls.length === 1) await gate;
      cursor = message.stream;
    });
    stream.registry.register({
      scope,
      consumerKey: "query",
      getDependencies: () => ({ pageIds: ["page-1"] }),
      getCursor: () => cursor,
      invalidate,
    });
    stream.publish(effectMessage(1));
    await flush();
    expect(invalidate).toHaveBeenCalledOnce();
    stream.publish(effectMessage(2));
    release();
    await flush();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(cursor.commitSeq).toBe(2);
  });

  test("bounds generic canonical reads during a sustained effect burst", async () => {
    vi.useFakeTimers();
    try {
      const stream = harness({ quietMs: 100, maxMs: 500 });
      let cursor = { storeEpoch: "epoch-1", commitSeq: 0 };
      const invalidate = vi.fn(async (message: ProjectionInvalidationCause) => {
        cursor = message.stream;
      });
      stream.registry.register({
        scope,
        consumerKey: "burst-query",
        getDependencies: () => ({ pageIds: ["page-1"] }),
        getCursor: () => cursor,
        invalidate,
      });

      for (let commitSeq = 1; commitSeq <= 300; commitSeq += 1) {
        stream.publish(effectMessage(commitSeq));
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTicks();

      expect(invalidate).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          stream: { storeEpoch: "epoch-1", commitSeq: 300 },
        }),
      );
      expect(cursor.commitSeq).toBe(300);
      stream.registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps long generic effect streams inside the production repair budget", async () => {
    vi.useFakeTimers();
    try {
      const stream = harness(INTERACTIVE_PROJECTION_REPAIR_BURST);
      let cursor = { storeEpoch: "epoch-1", commitSeq: 0 };
      const invalidate = vi.fn(async (message: ProjectionInvalidationCause) => {
        cursor = message.stream;
      });
      stream.registry.register({
        scope,
        consumerKey: "long-burst-query",
        getDependencies: () => ({ pageIds: ["page-1"] }),
        getCursor: () => cursor,
        invalidate,
      });

      for (let commitSeq = 1; commitSeq <= 400; commitSeq += 1) {
        stream.publish(effectMessage(commitSeq));
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(INTERACTIVE_PROJECTION_REPAIR_BURST.quietMs);
      await vi.runAllTicks();

      expect(invalidate.mock.calls.length).toBeGreaterThan(1);
      expect(invalidate.mock.calls.length).toBeLessThanOrEqual(9);
      expect(invalidate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          stream: { storeEpoch: "epoch-1", commitSeq: 400 },
        }),
      );
      expect(cursor.commitSeq).toBe(400);
      stream.registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
