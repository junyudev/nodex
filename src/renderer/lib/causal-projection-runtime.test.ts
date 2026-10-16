import { describe, expect, test, vi } from "vite-plus/test";
import type { ProjectionCoordinate, ProjectionDelivery } from "../../shared/projection-stream";
import {
  CausalProjectionRuntime,
  INTERACTIVE_PROJECTION_REPAIR_BURST,
} from "./causal-projection-runtime";

const scope = {
  schema_version: 1,
  canonical_key: "scope:page-1",
  scope: {
    kind: "page" as const,
    project_id: "project-1",
    page_id: "page-1",
  },
};

const coordinate = (revision: number, coveredCommitSeq = revision): ProjectionCoordinate => ({
  storeEpoch: "epoch-1",
  scopeKey: scope.canonical_key,
  schemaVersion: scope.schema_version,
  revision,
  coveredCommitSeq,
  effectHash: revision === 0 ? null : String(revision).padStart(64, "a").slice(-64),
});

const delivery = (
  resultRevision: number,
  options: {
    readonly patch?: boolean;
    readonly requiresRead?: boolean;
    readonly hash?: string;
  } = {},
): ProjectionDelivery => ({
  storeEpoch: "epoch-1",
  commitSeq: resultRevision,
  manifestHash: String(resultRevision).padStart(64, "b").slice(-64),
  operationId: `operation-${resultRevision}`,
  committedAt: "2026-08-06T00:00:00.000Z",
  impact: {
    kind: "resources",
    page_ids: ["page-1"],
    database_ids: [],
    data_source_ids: [],
    view_ids: [],
    document_heads: [],
  },
  effect: {
    scope,
    baseRevision: resultRevision - 1,
    resultRevision,
    coveredCommitSeq: resultRevision,
    patch:
      options.patch === false
        ? null
        : {
            kind: "page_changed",
            projectId: "project-1",
            pageId: "page-1",
          },
    requiresReadAtLeast: options.requiresRead ?? false,
    effectHash: options.hash ?? String(resultRevision).padStart(64, "a").slice(-64),
  },
});

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const immediateRepairBurst = { quietMs: 0, maxMs: 0 } as const;

describe("CausalProjectionRuntime", () => {
  test("applies a contiguous patch synchronously before background repair", async () => {
    let current = coordinate(0, 0);
    let visibleRevision = 0;
    let release!: () => void;
    const repairGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new CausalProjectionRuntime({
      scopeKey: scope.canonical_key,
      schemaVersion: 1,
      repairBurst: immediateRepairBurst,
      getCoordinate: () => current,
      apply: (effect) => {
        visibleRevision = effect.resultRevision;
        current = coordinate(effect.resultRevision);
      },
      readAtLeast: async () => await repairGate,
    });

    runtime.accept(delivery(1, { requiresRead: true }));

    expect(visibleRevision).toBe(1);
    expect(current.revision).toBe(1);
    await flush();
    expect(runtime.diagnostics().repairing).toBe(true);
    release();
    await flush();
  });

  test("buffers an out-of-order successor and replays it after the missing effect", () => {
    let current = coordinate(0, 0);
    const applied: number[] = [];
    const runtime = new CausalProjectionRuntime({
      scopeKey: scope.canonical_key,
      schemaVersion: 1,
      repairBurst: immediateRepairBurst,
      getCoordinate: () => current,
      apply: (effect) => {
        applied.push(effect.resultRevision);
        current = coordinate(effect.resultRevision);
      },
      readAtLeast: () => new Promise(() => undefined),
    });

    runtime.accept(delivery(2));
    expect(applied).toEqual([]);
    expect(runtime.diagnostics().bufferedEffects).toBe(1);
    runtime.accept(delivery(1));

    expect(applied).toEqual([1, 2]);
    expect(current.revision).toBe(2);
  });

  test("treats an exact replay as a no-op and repairs a hash collision", async () => {
    let current = coordinate(1);
    const apply = vi.fn();
    const repair = vi.fn(async () => undefined);
    const integrity = vi.fn();
    const runtime = new CausalProjectionRuntime({
      scopeKey: scope.canonical_key,
      schemaVersion: 1,
      repairBurst: immediateRepairBurst,
      getCoordinate: () => current,
      apply,
      readAtLeast: repair,
      onIntegrityFailure: integrity,
    });

    runtime.accept(delivery(1));
    runtime.accept(delivery(1, { hash: "f".repeat(64) }));
    await flush();

    expect(apply).not.toHaveBeenCalled();
    expect(integrity).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
    current = coordinate(1);
  });

  test("repairs a later subscription checkpoint received while the first repair is pending", async () => {
    let current = coordinate(0, 4);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repair = vi.fn(async (request: { readonly minimumCommitSeq: number }) => {
      await gate;
      current = coordinate(0, request.minimumCommitSeq);
    });
    const runtime = new CausalProjectionRuntime({
      scopeKey: scope.canonical_key,
      schemaVersion: 1,
      repairBurst: immediateRepairBurst,
      getCoordinate: () => current,
      apply: vi.fn(),
      readAtLeast: repair,
    });
    runtime.observeSubscriptionCheckpoint({
      storeEpoch: "epoch-1",
      scannedThroughCommitSeq: 4,
    });
    await flush();
    expect(repair).not.toHaveBeenCalled();

    runtime.observeSubscriptionCheckpoint({
      storeEpoch: "epoch-1",
      scannedThroughCommitSeq: 5,
    });
    await flush();
    expect(repair).toHaveBeenCalledOnce();
    runtime.observeSubscriptionCheckpoint({
      storeEpoch: "epoch-1",
      scannedThroughCommitSeq: 6,
    });
    release();
    await flush();
    await flush();

    expect(repair).toHaveBeenCalledTimes(2);
    expect(repair).toHaveBeenLastCalledWith(
      expect.objectContaining({
        minimumCommitSeq: 6,
        reason: "subscription_checkpoint_gap",
      }),
    );
    runtime.observeSubscriptionCheckpoint({
      storeEpoch: "epoch-1",
      scannedThroughCommitSeq: 6,
    });
    await flush();
    expect(repair).toHaveBeenCalledTimes(2);

    runtime.reset({ storeEpoch: "epoch-1", commitSeq: 6 });
    await flush();
    expect(repair).toHaveBeenCalledTimes(3);
    expect(repair).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimumCommitSeq: 6, reason: "stream_reset" }),
    );
    runtime.dispose();
  });

  test("does not carry an old epoch revision into a subscription checkpoint repair", async () => {
    let current = coordinate(100);
    const repair = vi.fn(async () => {
      current = { ...coordinate(1), storeEpoch: "epoch-2" };
    });
    const runtime = new CausalProjectionRuntime({
      scopeKey: scope.canonical_key,
      schemaVersion: 1,
      repairBurst: immediateRepairBurst,
      getCoordinate: () => current,
      apply: vi.fn(),
      readAtLeast: repair,
    });
    try {
      runtime.observeSubscriptionCheckpoint({
        storeEpoch: "epoch-2",
        scannedThroughCommitSeq: 1,
      });
      await flush();
      expect(repair).toHaveBeenCalledOnce();
      expect(repair).toHaveBeenCalledWith(
        expect.objectContaining({
          storeEpoch: "epoch-2",
          minimumRevision: 0,
          minimumCommitSeq: 1,
        }),
      );
      expect(runtime.diagnostics().requiredRepair).toBeNull();
    } finally {
      runtime.dispose();
    }
  });

  test("bounds buffered effects and canonical reads during a sustained patchless burst", async () => {
    vi.useFakeTimers();
    try {
      let current = coordinate(0, 0);
      const repair = vi.fn(
        async (request: {
          readonly minimumRevision: number;
          readonly minimumCommitSeq: number;
        }) => {
          current = coordinate(request.minimumRevision, request.minimumCommitSeq);
        },
      );
      const runtime = new CausalProjectionRuntime({
        scopeKey: scope.canonical_key,
        schemaVersion: 1,
        getCoordinate: () => current,
        apply: vi.fn(),
        readAtLeast: repair,
      });

      for (let revision = 1; revision <= 300; revision += 1) {
        runtime.accept(delivery(revision, { patch: false }));
        await vi.advanceTimersByTimeAsync(1);
      }

      expect(runtime.diagnostics().bufferedEffects).toBeLessThanOrEqual(128);
      await vi.advanceTimersByTimeAsync(INTERACTIVE_PROJECTION_REPAIR_BURST.quietMs);
      await vi.runAllTicks();

      expect(repair).toHaveBeenCalledOnce();
      expect(repair).toHaveBeenLastCalledWith(
        expect.objectContaining({
          minimumRevision: 300,
          minimumCommitSeq: 300,
        }),
      );
      expect(current.revision).toBe(300);
      expect(runtime.diagnostics().bufferedEffects).toBe(0);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps a long continuous editing stream inside the repair budget", async () => {
    vi.useFakeTimers();
    try {
      let current = coordinate(0, 0);
      const repair = vi.fn(
        async (request: {
          readonly minimumRevision: number;
          readonly minimumCommitSeq: number;
        }) => {
          current = coordinate(request.minimumRevision, request.minimumCommitSeq);
        },
      );
      const runtime = new CausalProjectionRuntime({
        scopeKey: scope.canonical_key,
        schemaVersion: 1,
        getCoordinate: () => current,
        apply: vi.fn(),
        readAtLeast: repair,
      });

      for (let revision = 1; revision <= 400; revision += 1) {
        runtime.accept(delivery(revision, { patch: false }));
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(INTERACTIVE_PROJECTION_REPAIR_BURST.quietMs);
      await vi.runAllTicks();

      expect(repair.mock.calls.length).toBeGreaterThan(1);
      expect(repair.mock.calls.length).toBeLessThanOrEqual(9);
      expect(repair).toHaveBeenLastCalledWith(
        expect.objectContaining({
          minimumRevision: 400,
          minimumCommitSeq: 400,
        }),
      );
      expect(current.revision).toBe(400);
      expect(runtime.diagnostics().bufferedEffects).toBe(0);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops a failed repair loop after its owner disposes the runtime", async () => {
    vi.useFakeTimers();
    try {
      const repair = vi.fn(async () => {
        throw new Error("Core unavailable");
      });
      const runtime = new CausalProjectionRuntime({
        scopeKey: scope.canonical_key,
        schemaVersion: 1,
        repairBurst: immediateRepairBurst,
        getCoordinate: () => coordinate(0, 0),
        apply: vi.fn(),
        readAtLeast: repair,
      });

      runtime.accept(delivery(1, { patch: false }));
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(0);
      expect(repair).toHaveBeenCalledOnce();

      runtime.dispose();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(repair).toHaveBeenCalledOnce();
      expect(runtime.diagnostics()).toMatchObject({
        bufferedEffects: 0,
        repairing: false,
        requiredRepair: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("backs off failed repairs while routine effects keep arriving", async () => {
    vi.useFakeTimers();
    try {
      const repair = vi.fn(async () => {
        throw new Error("Core unavailable");
      });
      const runtime = new CausalProjectionRuntime({
        scopeKey: scope.canonical_key,
        schemaVersion: 1,
        repairBurst: immediateRepairBurst,
        getCoordinate: () => coordinate(0, 0),
        apply: vi.fn(),
        readAtLeast: repair,
      });

      runtime.accept(delivery(1, { patch: false }));
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(0);
      expect(repair).toHaveBeenCalledOnce();

      for (let revision = 2; revision <= 80; revision += 1) {
        runtime.accept(delivery(revision, { patch: false }));
      }
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(99);
      expect(repair).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      expect(repair).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(199);
      expect(repair).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(repair).toHaveBeenCalledTimes(3);

      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
