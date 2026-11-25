import { describe, expect, test, vi, it } from "vite-plus/test";
import type { ProjectionCoordinate, ProjectionDelivery } from "../../shared/projection-stream";
import {
  CausalProjectionRuntime,
  INTERACTIVE_PROJECTION_REPAIR_BURST,
} from "./causal-projection-runtime";
import type {
  DatabaseApplyOperationV2,
  DatabaseApplyV2,
  LibraryDatabaseApplyV2,
} from "../../shared/database-module-v2";
import type { LibraryModuleApplyRequest } from "../../shared/library-module";
import type { PageLifecycleMutationRequestV2 } from "../../shared/page-lifecycle-v2";
import {
  databaseSettingsApplyCommand,
  libraryCommandFor,
  libraryDatabaseCommandFor,
  pageLifecycleCommandFor,
  projectDatabaseCommandFor,
} from "./core-projection-commands";
import { createExactRemoteSubscriptionLifecycle } from "./exact-remote-subscription-lifecycle";

describe("causal projection runtime", () => {
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
});

describe("core projection commands", () => {
  const databaseRequest = (
    operations: readonly Pick<DatabaseApplyOperationV2, "kind">[],
  ): DatabaseApplyV2 => ({ operations }) as DatabaseApplyV2;

  const libraryDatabaseRequest = (
    operations: readonly Pick<DatabaseApplyOperationV2, "kind">[],
  ): LibraryDatabaseApplyV2 => ({ operations }) as LibraryDatabaseApplyV2;

  describe("aggregate Core projection command routing", () => {
    it("keeps Database Settings pending until its causally newer descriptor is returned", () => {
      expect(databaseSettingsApplyCommand).toMatchObject({
        key: "database.settings.apply",
        owner: "DatabaseSettingsRuntime",
        protocol: { kind: "pending_operation" },
      });
    });

    it("routes each operation family to a semantic definition", () => {
      expect(projectDatabaseCommandFor(databaseRequest([{ kind: "put_view" }])).key).toBe(
        "database.put_view",
      );
      expect(
        libraryCommandFor({ operation: { kind: "create_page" } } as LibraryModuleApplyRequest).key,
      ).toBe("library.create_page");
      expect(
        pageLifecycleCommandFor({
          operation: { kind: "archive_page" },
        } as PageLifecycleMutationRequestV2).key,
      ).toBe("page_lifecycle.archive_page");
    });

    it("routes Page relocation and Undo through Library-owned semantic definitions", () => {
      expect(
        libraryCommandFor({ operation: { kind: "move_page" } } as LibraryModuleApplyRequest),
      ).toMatchObject({
        key: "library.move_page",
        owner: "LibraryOperationRuntime",
        protocol: { kind: "pending_operation" },
      });
      expect(
        libraryCommandFor({
          operation: { kind: "undo_page_relocation" },
        } as LibraryModuleApplyRequest).key,
      ).toBe("library.undo_page_relocation");
    });

    it("rejects an empty or unowned mixed Database batch", () => {
      expect(() => projectDatabaseCommandFor(databaseRequest([]))).toThrow(
        "Database apply requires at least one operation",
      );
      expect(() =>
        projectDatabaseCommandFor(databaseRequest([{ kind: "put_view" }, { kind: "delete_view" }])),
      ).toThrow("mixed operation kinds requires an owning semantic command");
    });

    it("allows a homogeneous atomic Database batch", () => {
      expect(
        projectDatabaseCommandFor(databaseRequest([{ kind: "put_option" }, { kind: "put_option" }]))
          .key,
      ).toBe("database.put_option");
    });

    it("routes atomic View publication through its owning semantic command", () => {
      const operations = [{ kind: "put_view" }, { kind: "put_view_personal_preferences" }] as const;

      expect(projectDatabaseCommandFor(databaseRequest(operations)).key).toBe(
        "database.publish_view",
      );
      expect(libraryDatabaseCommandFor(libraryDatabaseRequest(operations)).key).toBe(
        "library_database.publish_view",
      );
    });

    it("routes atomic cross-group Page movement through its owning semantic command", () => {
      const operations = [{ kind: "edit_property_values" }, { kind: "position_pages" }] as const;

      expect(projectDatabaseCommandFor(databaseRequest(operations)).key).toBe(
        "database.move_pages",
      );
      expect(libraryDatabaseCommandFor(libraryDatabaseRequest([...operations].reverse())).key).toBe(
        "library_database.move_pages",
      );
    });

    it("covers the other mixed operation sets emitted by renderer compilers", () => {
      expect(
        projectDatabaseCommandFor(
          databaseRequest([{ kind: "edit_property_values" }, { kind: "position_page" }]),
        ).key,
      ).toBe("database.move_page");
      expect(
        libraryDatabaseCommandFor(
          libraryDatabaseRequest([{ kind: "put_option" }, { kind: "edit_property_values" }]),
        ).key,
      ).toBe("library_database.create_option_and_select");
    });
  });
});

describe("exact remote subscription lifecycle", () => {
  test("terminal invalidation prevents a delayed open from becoming evidence for a new lease", async () => {
    let complete: (value: boolean) => void = () => undefined;
    const open = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const lifecycle = createExactRemoteSubscriptionLifecycle({
      hasSubscribers: () => true,
      open,
      isOpenResult: (value) => value,
      alreadyOpenResult: () => true,
      inactiveResult: () => false,
      close: async () => undefined,
      finalize: () => undefined,
    });
    const stale = lifecycle.ensure();
    lifecycle.invalidate();
    complete(true);
    expect(await stale).toBe(false);
    const replacement = lifecycle.ensure();
    expect(open).toHaveBeenCalledTimes(2);
    complete(true);
    expect(await replacement).toBe(true);
    expect(await lifecycle.ensure()).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
  });

  test.each(["opening", "open"])(
    "release fences queued commands while %s, including immediate revival",
    async (phase) => {
      let subscribed = true;
      let complete: (value: boolean) => void = () => undefined;
      const open = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            complete = resolve;
          }),
      );
      const close = vi.fn(async () => undefined);
      const lifecycle = createExactRemoteSubscriptionLifecycle({
        hasSubscribers: () => subscribed,
        open,
        isOpenResult: (value) => value,
        alreadyOpenResult: () => true,
        inactiveResult: () => false,
        close,
        finalize: () => undefined,
      });
      const opening = lifecycle.ensure();
      if (phase === "open") {
        complete(true);
        await opening;
      }
      const send = vi.fn(async () => "sent");
      const run = () => lifecycle.run(async (ready) => (ready ? send() : "inactive"));
      const stale = run();
      subscribed = false;
      lifecycle.releaseIfIdle();
      subscribed = true;
      const secondStale = run();
      subscribed = false;
      lifecycle.releaseIfIdle();
      subscribed = true;
      if (phase === "opening") complete(true);
      expect(await stale).toBe("inactive");
      expect(await secondStale).toBe("inactive");
      expect(send).not.toHaveBeenCalled();
      expect(await run()).toBe("sent");
      expect(close).not.toHaveBeenCalled();
      subscribed = false;
      lifecycle.releaseIfIdle();
      expect(await run()).toBe("inactive");
    },
  );
});
