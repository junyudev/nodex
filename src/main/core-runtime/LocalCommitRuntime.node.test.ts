import { describe, expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { assert, it, describe as describeCoreMinimumCommit } from "@effect/vitest";
import type {
  CoreAuthorizedDeliveryPacket,
  CoreEventEnvelope,
  DocumentLiveBarrier,
  DocumentLiveRepair,
  AutomationApplyInput,
  AutomationApplyResult,
  AutomationRead,
  AutomationReadSnapshot,
  LibraryApplyResult,
  LibraryReadSnapshot,
  QueryReadSnapshot,
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceApplyResult,
} from "../core-client/types";
import { createCoreLocalCommitFixture } from "../core-client/testing/local-commit-fixture";
import {
  LocalCommitRuntimeError,
  make,
  type LocalCommitRuntimeOptions,
} from "./LocalCommitRuntime";
import { TestClock } from "effect/testing";
import type { DocumentSyncRealtimeEvent } from "../../shared/block-documents/document-sync";
import {
  documentLiveRuntimeError,
  make as makeDocumentLiveRuntime,
  type DocumentLivePhysicalSubscription,
  type DocumentLiveSubscriptionInput,
} from "./DocumentLiveRuntime";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import { CoreSessionAccess } from "./CoreAuthority";
import { CoreModules, live } from "./CoreModules";
import { CoreApplicationAgent } from "./CoreApplicationAgent";
import * as Ref from "effect/Ref";
import {
  CoreMinimumCommitTimeout,
  CoreStoreEpochMismatch,
  readCoreProjectionAtLeast,
  readCoreSnapshotAtLeast,
} from "./CoreMinimumCommit";
import { it as itoperationidentity } from "vitest";
import { createDueWorkOperationId, createStableOperationId } from "./operation-identity";

describe("LocalCommitRuntime", () => {
  const projectionEffect = (
    revision: number,
    scopeKey = "scope-view-1",
    coveredCommitSeq = revision,
  ): CoreAuthorizedDeliveryPacket["projection_effects"][number] => ({
    scope: {
      schema_version: 1,
      canonical_key: scopeKey,
      scope: {
        kind: "database_view",
        project_id: "project-1",
        database_id: "database-1",
        data_source_id: "source-1",
        view_id: "view-1",
      },
    },
    base_revision: revision - 1,
    result_revision: revision,
    covered_commit_seq: coveredCommitSeq,
    patch: null,
    requires_read_at_least: true,
    effect_hash: String(revision).padStart(64, "a").slice(-64),
  });

  const documentEffect = (
    documentId: string,
    baseHeadSeq: number,
    resultHeadSeq: number,
    effectOrder: number,
  ): CoreAuthorizedDeliveryPacket["document_effects"][number] => ({
    reference: {
      base_head_seq: baseHeadSeq,
      document_id: documentId,
      effect_order: effectOrder,
      generation: 1,
      page_id: null,
      resource_kind: "document_update",
      result_head_seq: resultHeadSeq,
      update_byte_length: 1,
      update_hash: String(resultHeadSeq).padStart(64, "b").slice(-64),
      update_id: `update:${documentId}:${resultHeadSeq}`,
    },
    inline_update: null,
  });

  const commit = (
    commitSeq: number,
    options: {
      readonly manifestHash?: string;
      readonly documentEffects?: CoreAuthorizedDeliveryPacket["document_effects"];
      readonly projectionEffects?: CoreAuthorizedDeliveryPacket["projection_effects"];
    } = {},
  ): CoreAuthorizedDeliveryPacket =>
    createCoreLocalCommitFixture({
      commitSeq,
      canonicalHash: options.manifestHash ?? String(commitSeq).padStart(64, "0"),
      documentEffects: options.documentEffects,
      projectionEffects: options.projectionEffects,
      payload: {
        module: "project_workspace",
        library_id: "library-1",
        event: {
          kind: "workspace_changed",
          project_catalog_change: null,
          project_ids: [],
          session_ids: [],
          thread_ids: [],
          session_summary_scopes: [],
          session_detail_ids: [],
        },
      },
    });

  const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error(`LocalCommit condition did not settle: ${label}`));
    });

  const waitUntilEffect = (label: string, predicate: Effect.Effect<boolean>): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (yield* predicate) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error(`LocalCommit condition did not settle: ${label}`));
    });

  const makeHarness = (overrides: Partial<LocalCommitRuntimeOptions> = {}) =>
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      const runtime = yield* make({
        expectedLibraryId: "library-1",
        expectedStoreEpoch: "epoch-1",
        onDocument: () => Effect.void,
        onProjection: () => Effect.void,
        onNotification: () => Effect.void,
        ...overrides,
      }).pipe(Effect.provideService(Scope.Scope, ownerScope));
      return { ownerScope, runtime };
    });

  const closeHarness = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
    Scope.close(harness.ownerScope, Exit.void);

  it.effect("admits work without waiting for a blocked causal lane", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let started = false;
      const harness = yield* makeHarness({
        onProjection: () =>
          Effect.sync(() => {
            started = true;
          }).pipe(Effect.andThen(Deferred.await(gate))),
      });

      assert.strictEqual(
        (yield* harness.runtime.admit(
          commit(1, { projectionEffects: [projectionEffect(1)] }),
          "projection_live",
        )).kind,
        "accepted",
      );
      assert.strictEqual((yield* harness.runtime.diagnostics).pendingDeliveries, 2);
      yield* waitUntil("projection starts", () => started);
      yield* Deferred.succeed(gate, undefined);
      yield* waitUntilEffect(
        "all lanes retire",
        harness.runtime.diagnostics.pipe(
          Effect.map((diagnostics) => diagnostics.pendingDeliveries === 0),
        ),
      );
      yield* closeHarness(harness);
    }),
  );

  it.effect("isolates lane keys and preserves FIFO inside each lane", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const delivered: string[] = [];
      const harness = yield* makeHarness({
        onProjection: (_packet, effect) =>
          Effect.sync(() => {
            delivered.push(`${effect.scope.canonical_key}:${effect.result_revision}`);
          }).pipe(
            Effect.andThen(
              effect.scope.canonical_key === "scope-blocked" && effect.result_revision === 2
                ? Deferred.await(gate)
                : Effect.void,
            ),
          ),
        onNotification: (packet) =>
          Effect.sync(() => {
            delivered.push(`notification:${packet.manifest.identity.commit_seq}`);
          }),
      });

      yield* harness.runtime.admit(
        commit(2, { projectionEffects: [projectionEffect(2, "scope-blocked")] }),
        "projection_live",
      );
      yield* harness.runtime.admit(
        commit(1, { projectionEffects: [projectionEffect(1, "scope-blocked")] }),
        "tailer",
      );
      yield* harness.runtime.admit(
        commit(3, { projectionEffects: [projectionEffect(3, "scope-free")] }),
        "tailer",
      );
      yield* waitUntil("independent deliveries", () => delivered.length >= 5);

      assert.includeMembers(delivered, [
        "scope-blocked:2",
        "scope-free:3",
        "notification:1",
        "notification:2",
        "notification:3",
      ]);
      assert.notInclude(delivered, "scope-blocked:1");
      yield* Deferred.succeed(gate, undefined);
      yield* waitUntil("blocked lane continues", () => delivered.includes("scope-blocked:1"));
      assert.isBelow(delivered.indexOf("scope-blocked:2"), delivered.indexOf("scope-blocked:1"));
      yield* closeHarness(harness);
    }),
  );

  it.effect("serializes overlapping Document sets without cross-Document blocking", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const delivered: string[] = [];
      const harness = yield* makeHarness({
        onDocument: (packet, documentId) => {
          const coordinate = `${documentId}:${packet.manifest.identity.commit_seq}`;
          return Effect.sync(() => {
            delivered.push(coordinate);
          }).pipe(
            Effect.andThen(coordinate === "document:one:1" ? Deferred.await(gate) : Effect.void),
          );
        },
      });
      yield* harness.runtime.admit(
        commit(1, {
          documentEffects: [
            documentEffect("document:one", 0, 1, 0),
            documentEffect("document:two", 0, 1, 1),
          ],
        }),
        "projection_live",
      );
      yield* harness.runtime.admit(
        commit(2, { documentEffects: [documentEffect("document:one", 1, 2, 0)] }),
        "tailer",
      );
      yield* waitUntil("first document set", () => delivered.length >= 2);
      assert.deepEqual(delivered, ["document:one:1", "document:two:1"]);
      yield* Deferred.succeed(gate, undefined);
      yield* waitUntil("overlapping document continues", () => delivered.length === 3);
      assert.deepEqual(delivered, ["document:one:1", "document:two:1", "document:one:2"]);
      yield* closeHarness(harness);
    }),
  );

  it.effect("deduplicates response and replay coverage while admitting later enrichment", () =>
    Effect.gen(function* () {
      let notifications = 0;
      let projections = 0;
      const harness = yield* makeHarness({
        onNotification: () =>
          Effect.sync(() => {
            notifications += 1;
          }),
        onProjection: () =>
          Effect.sync(() => {
            projections += 1;
          }),
      });
      const sparse = commit(3);
      const rich = commit(3, { projectionEffects: [projectionEffect(1, "scope-view-1", 3)] });

      assert.strictEqual(
        (yield* harness.runtime.admit(sparse, "projection_live")).kind,
        "accepted",
      );
      assert.strictEqual((yield* harness.runtime.admit(sparse, "tailer")).kind, "duplicate");
      assert.strictEqual((yield* harness.runtime.admitAndWait(rich, "tailer")).kind, "enriched");
      assert.strictEqual(notifications, 1);
      assert.strictEqual(projections, 1);
      yield* closeHarness(harness);
    }),
  );

  it.effect("accepts durable-tail first and absorbs the later scoped-live copy", () =>
    Effect.gen(function* () {
      let notifications = 0;
      let projections = 0;
      const harness = yield* makeHarness({
        onNotification: () =>
          Effect.sync(() => {
            notifications += 1;
          }),
        onProjection: () =>
          Effect.sync(() => {
            projections += 1;
          }),
      });
      const packet = commit(5, {
        projectionEffects: [projectionEffect(1, "scope-tail-first", 5)],
      });

      assert.strictEqual((yield* harness.runtime.admit(packet, "tailer")).kind, "accepted");
      assert.strictEqual(
        (yield* harness.runtime.admit(packet, "projection_live")).kind,
        "duplicate",
      );
      yield* harness.runtime.admitAndWait(packet, "tailer");
      assert.strictEqual(notifications, 1);
      assert.strictEqual(projections, 1);
      yield* closeHarness(harness);
    }),
  );

  it.effect("rejects a Manifest collision before scheduling any enriched work", () =>
    Effect.gen(function* () {
      let projections = 0;
      const harness = yield* makeHarness({
        onProjection: () =>
          Effect.sync(() => {
            projections += 1;
          }),
      });
      yield* harness.runtime.admitAndWait(
        commit(4, { projectionEffects: [projectionEffect(1, "scope-manifest", 4)] }),
        "tailer",
      );
      const collision = yield* Effect.exit(
        harness.runtime.admit(
          commit(4, {
            manifestHash: "f".repeat(64),
            projectionEffects: [projectionEffect(1, "scope-other", 4)],
          }),
          "projection_live",
        ),
      );

      assert.isTrue(Exit.isFailure(collision));
      assert.strictEqual(projections, 1);
      yield* closeHarness(harness);
    }),
  );

  it.effect("makes durable replay attach to scoped-live work and reclaim terminal failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let failures = 0;
      const harness = yield* makeHarness({
        onProjection: () =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts <= 3 ? Effect.die(new Error(`failure-${attempts}`)) : Effect.void;
          }),
        onError: () =>
          Effect.sync(() => {
            failures += 1;
          }),
      });
      const packet = commit(6, { projectionEffects: [projectionEffect(1, "scope-retry", 6)] });

      yield* harness.runtime.admit(packet, "projection_live");
      const failed = yield* Effect.exit(harness.runtime.admitAndWait(packet, "tailer"));
      assert.isTrue(Exit.isFailure(failed));
      if (Exit.isFailure(failed)) {
        const error = Cause.squash(failed.cause);
        assert.isTrue(Schema.is(LocalCommitRuntimeError)(error));
        if (Schema.is(LocalCommitRuntimeError)(error)) {
          assert.strictEqual(error.operation, "deliver.projection");
        }
      }
      assert.strictEqual(failures, 1);
      assert.strictEqual((yield* harness.runtime.admitAndWait(packet, "tailer")).kind, "enriched");
      assert.strictEqual(attempts, 4);
      yield* closeHarness(harness);
    }),
  );

  it.effect("continues a causal lane after one queued delivery fails terminally", () =>
    Effect.gen(function* () {
      const delivered: number[] = [];
      const harness = yield* makeHarness({
        onProjection: (_packet, effect) =>
          effect.result_revision === 1
            ? Effect.die(new Error("terminal"))
            : Effect.sync(() => {
                delivered.push(effect.result_revision);
              }),
      });
      const failedPacket = commit(41, {
        projectionEffects: [projectionEffect(1, "scope-survives", 41)],
      });
      const nextPacket = commit(42, {
        projectionEffects: [projectionEffect(2, "scope-survives", 42)],
      });
      yield* harness.runtime.admit(failedPacket, "projection_live");
      yield* harness.runtime.admit(nextPacket, "projection_live");

      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(harness.runtime.admitAndWait(failedPacket, "tailer"))),
      );
      assert.strictEqual(
        (yield* harness.runtime.admitAndWait(nextPacket, "tailer")).kind,
        "duplicate",
      );
      assert.deepEqual(delivered, [2]);
      yield* closeHarness(harness);
    }),
  );

  it.effect("keeps shared delivery alive when its first durable waiter is interrupted", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let started = false;
      let completed = false;
      const harness = yield* makeHarness({
        onProjection: () =>
          Effect.sync(() => {
            started = true;
          }).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
          ),
      });
      const packet = commit(8, { projectionEffects: [projectionEffect(1, "scope-shared", 8)] });
      const waiter = yield* Effect.forkChild(harness.runtime.admitAndWait(packet, "tailer"));
      yield* waitUntil("shared delivery starts", () => started);
      yield* Fiber.interrupt(waiter);
      yield* Deferred.succeed(gate, undefined);
      yield* waitUntil("shared delivery completes", () => completed);

      assert.strictEqual((yield* harness.runtime.admitAndWait(packet, "tailer")).kind, "duplicate");
      yield* closeHarness(harness);
    }),
  );

  it.effect("rejects collisions atomically without retaining a valid enrichment prefix", () =>
    Effect.gen(function* () {
      const delivered: string[] = [];
      const harness = yield* makeHarness({
        onProjection: (_packet, effect) =>
          Effect.sync(() => {
            delivered.push(effect.scope.canonical_key);
          }),
      });
      yield* harness.runtime.admit(
        commit(7, { projectionEffects: [projectionEffect(1, "scope-view-1", 7)] }),
        "projection_live",
      );
      yield* waitUntil("initial projection", () => delivered.length === 1);
      delivered.length = 0;
      const validEnrichment = projectionEffect(1, "scope-view-2", 7);
      const rejected = yield* Effect.exit(
        harness.runtime.admit(
          commit(7, {
            projectionEffects: [
              validEnrichment,
              { ...projectionEffect(1, "scope-view-1", 7), effect_hash: "e".repeat(64) },
            ],
          }),
          "tailer",
        ),
      );
      assert.isTrue(Exit.isFailure(rejected));
      assert.isEmpty(delivered);

      assert.strictEqual(
        (yield* harness.runtime.admit(
          commit(7, { projectionEffects: [validEnrichment] }),
          "tailer",
        )).kind,
        "enriched",
      );
      yield* waitUntil("valid enrichment", () => delivered.length === 1);
      yield* closeHarness(harness);
    }),
  );

  it.effect("bounds completed commit memory and validates monotonic checkpoints", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ maxRememberedCommits: 2 });
      yield* harness.runtime.admitAndWait(commit(1), "tailer");
      yield* harness.runtime.admitAndWait(commit(2), "tailer");
      yield* harness.runtime.admitAndWait(commit(3), "tailer");
      yield* harness.runtime.observeCheckpoint({
        store_epoch: "epoch-1",
        generation: "generation-1",
        scanned_through_seq: 3,
        oldest_available_seq: 1,
        resync_token: null,
      });
      const diagnostics = yield* harness.runtime.diagnostics;
      assert.strictEqual(diagnostics.rememberedCommits, 2);
      assert.strictEqual(diagnostics.checkpoint?.scanned_through_seq, 3);

      const backwards = yield* Effect.exit(
        harness.runtime.observeCheckpoint({
          store_epoch: "epoch-1",
          generation: "generation-1",
          scanned_through_seq: 2,
          oldest_available_seq: 1,
          resync_token: null,
        }),
      );
      assert.isTrue(Exit.isFailure(backwards));
      yield* harness.runtime.resetStream("event_gap");
      assert.deepInclude(yield* harness.runtime.diagnostics, {
        checkpoint: null,
        lastResetReason: "event_gap",
      });
      yield* closeHarness(harness);
    }),
  );

  it.effect("keeps delivery audience in semantic claim identity", () =>
    Effect.gen(function* () {
      const audiences: CoreAuthorizedDeliveryPacket["delivery_address"][] = [];
      const harness = yield* makeHarness({
        onNotification: (packet) =>
          Effect.sync(() => {
            audiences.push(packet.delivery_address);
          }),
      });
      const base = commit(13);
      const project = (projectId: string, packetHash: string): CoreAuthorizedDeliveryPacket => ({
        ...base,
        delivery_address: { kind: "project", library_id: "library-1", project_id: projectId },
        packet_hash: packetHash,
      });
      assert.strictEqual(
        (yield* harness.runtime.admit(project("project-a", "c".repeat(64)), "tailer")).kind,
        "accepted",
      );
      assert.strictEqual(
        (yield* harness.runtime.admitAndWait(project("project-b", "d".repeat(64)), "tailer")).kind,
        "enriched",
      );

      assert.lengthOf(audiences, 2);
      assert.notDeepEqual(audiences[0], audiences[1]);
      yield* closeHarness(harness);
    }),
  );

  it.effect("fails closed for foreign Library scope and pending-capacity exhaustion", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        maxPendingDeliveries: 2,
        onProjection: () => Deferred.await(gate),
      });
      const foreign = yield* Effect.exit(
        harness.runtime.admit(
          createCoreLocalCommitFixture({
            deliveryAddress: { kind: "library", library_id: "library-other" },
            commitSeq: 12,
          }),
          "tailer",
        ),
      );
      assert.isTrue(Exit.isFailure(foreign));

      yield* harness.runtime.admit(
        commit(30, { projectionEffects: [projectionEffect(1, "scope-capacity", 30)] }),
        "projection_live",
      );
      const overflow = yield* Effect.exit(harness.runtime.admit(commit(31), "tailer"));
      assert.isTrue(Exit.isFailure(overflow));
      if (Exit.isFailure(overflow)) {
        const error = Cause.squash(overflow.cause);
        assert.isTrue(Schema.is(LocalCommitRuntimeError)(error));
        if (Schema.is(LocalCommitRuntimeError)(error)) {
          assert.strictEqual(error.operation, "admit.capacity");
        }
      }
      yield* Deferred.succeed(gate, undefined);
      yield* closeHarness(harness);
    }),
  );

  it.effect("closes all active lanes and fails durable waiters with the owning Scope", () =>
    Effect.gen(function* () {
      let interrupted = 0;
      const harness = yield* makeHarness({
        onProjection: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted += 1;
              }),
            ),
          ),
      });
      const packet = commit(40, { projectionEffects: [projectionEffect(1, "scope-close", 40)] });
      const waiter = yield* Effect.forkChild(harness.runtime.admitAndWait(packet, "tailer"));
      yield* waitUntilEffect(
        "lane becomes active",
        harness.runtime.diagnostics.pipe(
          Effect.map((diagnostics) => diagnostics.pendingDeliveries === 2),
        ),
      );
      yield* closeHarness(harness);
      const result = yield* Fiber.await(waiter);
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(interrupted, 1);
      assert.deepInclude(yield* harness.runtime.diagnostics, {
        activeLanes: { document: 0, projection: 0, notification: 0 },
        pendingDeliveries: 0,
        rememberedCommits: 0,
      });
    }),
  );
});

describe("DocumentLiveRuntime", () => {
  const make = makeDocumentLiveRuntime;
  const barrier: DocumentLiveBarrier = {
    store_epoch: "epoch:test",
    core_generation: "generation:test",
    document_id: "document:test",
    document_generation: 1,
    head_seq: 3,
    commit_head: 7,
    engine: "yjs",
  };

  const repair: DocumentLiveRepair = {
    document_id: barrier.document_id,
    store_epoch: barrier.store_epoch,
    document_generation: barrier.document_generation,
    head_seq: barrier.head_seq,
    commit_head: 8,
    reason: "receiver_lagged",
  };

  interface PendingOpening {
    readonly opened: Deferred.Deferred<
      DocumentLivePhysicalSubscription,
      ReturnType<typeof documentLiveRuntimeError>
    >;
    readonly done: Deferred.Deferred<void, ReturnType<typeof documentLiveRuntimeError>>;
    readonly onEvent: (event: CoreEventEnvelope) => void;
    readonly onRepair: (repair: DocumentLiveRepair) => void;
    readonly onRealtime: (event: DocumentSyncRealtimeEvent) => void;
    closeCount: number;
    interruptedCount: number;
  }

  const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      // oxlint-disable-next-line nodex/no-polling-loop-in-tests -- Yield to the Document lease delivery fiber without advancing the backoff clock.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error(`Document live condition did not settle: ${label}`));
    });

  const makeHarness = Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const runtime = yield* make.pipe(Effect.provideService(Scope.Scope, ownerScope));
    const openings: PendingOpening[] = [];
    const observations: string[] = [];
    const events: CoreEventEnvelope[] = [];

    const input: DocumentLiveSubscriptionInput = {
      open: (onEvent, onRepair, onRealtime) =>
        Effect.gen(function* () {
          const opened = yield* Deferred.make<
            DocumentLivePhysicalSubscription,
            ReturnType<typeof documentLiveRuntimeError>
          >();
          const done = yield* Deferred.make<void, ReturnType<typeof documentLiveRuntimeError>>();
          const opening: PendingOpening = {
            opened,
            done,
            onEvent,
            onRepair,
            onRealtime,
            closeCount: 0,
            interruptedCount: 0,
          };
          openings.push(opening);
          return yield* Deferred.await(opened).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                opening.interruptedCount += 1;
              }),
            ),
          );
        }),
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      onRepair: () =>
        Effect.sync(() => {
          observations.push("repair");
        }),
      onRealtime: () => Effect.void,
      onOpened: () => Effect.void,
      onInterrupted: (cause) =>
        Effect.sync(() => {
          observations.push(cause === null ? "interrupted:null" : "interrupted:error");
        }),
      onConnectionStateChanged: (state) =>
        Effect.sync(() => {
          observations.push(state);
        }),
      shouldRetry: () => true,
      maxInitialOpenAttempts: 3,
      retryDelay: "10 millis",
      maxRetryDelay: "40 millis",
    };

    const activate = (opening: PendingOpening): Effect.Effect<void> => {
      let closed = false;
      return Deferred.succeed(opening.opened, {
        barrier,
        done: Deferred.await(opening.done),
        close: Effect.sync(() => {
          if (closed) return;
          closed = true;
          opening.closeCount += 1;
          Deferred.doneUnsafe(opening.done, Effect.void);
        }),
      }).pipe(Effect.asVoid);
    };

    return { activate, events, input, observations, openings, ownerScope, runtime };
  });

  it.effect("disconnects and closes the old lease before delivering repair", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const lease = yield* harness.runtime.subscribe(harness.input);
      yield* waitUntil("first opening", () => harness.openings.length === 1);
      yield* harness.activate(harness.openings[0]!);
      yield* lease.ready;
      assert.deepEqual(harness.observations, ["connected"]);

      harness.openings[0]!.onRepair(repair);
      yield* waitUntil("replacement opening", () => harness.openings.length === 2);
      assert.deepEqual(harness.observations.slice(0, 3), ["connected", "disconnected", "repair"]);
      assert.strictEqual(harness.openings[0]!.closeCount, 1);

      yield* lease.close;
      yield* lease.done;
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("backs off through Effect Clock after a failed opening", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const lease = yield* harness.runtime.subscribe(harness.input);
      yield* waitUntil("failed opening", () => harness.openings.length === 1);
      yield* Deferred.fail(
        harness.openings[0]!.opened,
        documentLiveRuntimeError("test.open", new Error("offline")),
      );
      yield* waitUntil("retry wait", () => harness.observations.includes("interrupted:error"));
      yield* TestClock.adjust("9 millis");
      yield* Effect.yieldNow;
      assert.strictEqual(harness.openings.length, 1);
      yield* TestClock.adjust("1 millis");
      yield* waitUntil("retry opening", () => harness.openings.length === 2);

      yield* harness.activate(harness.openings[1]!);
      yield* lease.ready;
      yield* lease.close;
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("interrupts an opening and settles its public lease on close", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const lease = yield* harness.runtime.subscribe(harness.input);
      yield* waitUntil("pending opening", () => harness.openings.length === 1);
      yield* lease.close;
      yield* waitUntil("opening interruption", () => harness.openings[0]!.interruptedCount === 1);
      harness.openings[0]!.onEvent({} as CoreEventEnvelope);
      yield* Effect.yieldNow;
      assert.lengthOf(harness.events, 0);
      yield* lease.done;
      const ready = yield* Effect.flip(lease.ready);
      assert.strictEqual(ready.operation, "subscription.closed");
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("bounds callback ingress before the physical barrier", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const lease = yield* harness.runtime.subscribe(harness.input);
      yield* waitUntil("overflowing opening", () => harness.openings.length === 1);
      for (let index = 0; index < 513; index += 1) {
        harness.openings[0]!.onEvent({ sequence: index } as unknown as CoreEventEnvelope);
      }
      yield* waitUntil("overflow interruption", () => harness.openings[0]!.interruptedCount === 1);
      assert.lengthOf(harness.events, 0);
      yield* TestClock.adjust("10 millis");
      yield* waitUntil("overflow retry", () => harness.openings.length === 2);
      yield* lease.close;
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("wakes a disconnected retry when recovery is explicitly requested", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const lease = yield* harness.runtime.subscribe(harness.input);
      yield* waitUntil("first opening", () => harness.openings.length === 1);
      yield* harness.activate(harness.openings[0]!);
      yield* lease.ready;
      const connectionVersion = yield* lease.waitUntilConnected;
      yield* Deferred.succeed(harness.openings[0]!.done, undefined);
      yield* waitUntil("disconnected", () => harness.observations.includes("disconnected"));
      const reconnected = yield* Effect.forkChild(
        lease.reconnectAfterSubscriptionLoss(connectionVersion),
      );
      yield* waitUntil("explicit retry opening", () => harness.openings.length === 2);
      yield* harness.activate(harness.openings[1]!);
      yield* Fiber.join(reconnected);
      yield* lease.close;
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("does not retire a replacement for a late failure from an older connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const lease = yield* harness.runtime.subscribe(harness.input);
      yield* waitUntil("first opening", () => harness.openings.length === 1);
      yield* harness.activate(harness.openings[0]!);
      const oldVersion = yield* lease.waitUntilConnected;
      const first = yield* Effect.forkChild(lease.reconnectAfterSubscriptionLoss(oldVersion));
      const concurrent = yield* Effect.forkChild(lease.reconnectAfterSubscriptionLoss(oldVersion));
      yield* waitUntil("disconnected", () => harness.observations.includes("disconnected"));
      yield* TestClock.adjust("10 millis");
      yield* waitUntil("replacement", () => harness.openings.length === 2);
      yield* harness.activate(harness.openings[1]!);
      yield* Fiber.join(first);
      yield* Fiber.join(concurrent);
      yield* lease.reconnectAfterSubscriptionLoss(oldVersion);
      assert.strictEqual(harness.openings.length, 2);
      assert.strictEqual(harness.openings[1]!.closeCount, 0);
      assert.isAbove(yield* lease.waitUntilConnected, oldVersion);
      yield* lease.close;
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );
});

describe("CoreModules", () => {
  const provenance = {
    profile_id: "profile:a",
    authority: {
      thread_id: "thread:a",
      turn_id: "turn:a",
      root_thread_id: "thread:a",
      actor_project_id: "project:actor",
      library_id: "library:a",
      store_epoch: "epoch:a",
    },
  } as const;

  it.effect("forwards content and Automation project scope to the Core authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectScopes: Array<{
          readonly operation: string;
          readonly projectId?: string | null;
        }> = [];
        const client = {
          queryRead: () => Promise.resolve({} as QueryReadSnapshot),
          libraryRead: () => Promise.resolve({} as LibraryReadSnapshot),
          libraryApply: () => Promise.resolve({} as LibraryApplyResult),
          automationRead: () => Promise.resolve({} as AutomationReadSnapshot),
          automationApply: () => Promise.resolve({} as AutomationApplyResult),
        } as unknown as CoreGenerationClient;
        const access = CoreSessionAccess.of({
          use: (operation, run, options) =>
            Effect.promise((signal) => {
              projectScopes.push({ operation, projectId: options?.projectId });
              return run(client, signal);
            }),
          handshake: Effect.die("unused"),
        });
        const context = yield* Layer.build(
          live.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access))),
        );
        const core = Context.get(context, CoreModules);

        yield* core.query.read({} as never, "project:query");
        yield* core.library.read({} as never, undefined, "project:a");
        yield* core.library.apply({} as never, "project:a");
        yield* core.automation.read({} as never, undefined, "project:b");
        yield* core.automation.apply({} as never, undefined, "project:b");

        assert.deepStrictEqual(projectScopes, [
          { operation: "query.read", projectId: "project:query" },
          { operation: "library.read", projectId: "project:a" },
          { operation: "library.apply", projectId: "project:a" },
          { operation: "automation.read", projectId: "project:b" },
          { operation: "automation.apply", projectId: "project:b" },
        ]);
      }),
    ),
  );

  it.effect(
    "retains Agent provenance through Workspace owners without leaking into host commands",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests: Array<{ input: ProjectWorkspaceApplyInput; projectId?: string | null }> =
            [];
          let projectId: string | null | undefined;
          const client = {
            workspaceApply: (input: ProjectWorkspaceApplyInput) => {
              requests.push({ input, projectId });
              return Promise.resolve({} as ProjectWorkspaceApplyResult);
            },
          } as unknown as CoreGenerationClient;
          const access = CoreSessionAccess.of({
            use: (_operation, run, options) =>
              Effect.promise((signal) => {
                projectId = options?.projectId;
                return run(client, signal);
              }),
            handshake: Effect.die("unused"),
          });
          const context = yield* Layer.build(
            live.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access))),
          );
          const core = Context.get(context, CoreModules);
          const input: ProjectWorkspaceApplyInput = {
            operationId: "operation:a",
            intent: {
              kind: "rename_sidebar_section",
              section_id: "section:a",
              name: "Research",
              expected_revision: 1,
            },
          };
          yield* core.workspace
            .apply(input, undefined, "project:target")
            .pipe(Effect.provideService(CoreApplicationAgent, provenance));
          yield* core.workspace.apply(input, undefined, "project:host");
          assert.deepStrictEqual(requests, [
            {
              projectId: "project:actor",
              input: {
                ...input,
                intent: { kind: "agent_command", provenance, intent: input.intent },
              },
            },
            { projectId: "project:host", input },
          ]);
        }),
      ),
  );

  it.effect(
    "binds Agent Automation reads and commands without leaking authority to Host calls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests: Array<{
            readonly input: AutomationRead | AutomationApplyInput;
            readonly projectId: string | null | undefined;
          }> = [];
          let projectId: string | null | undefined;
          let admissions = 0;
          const client = {
            automationRead: (input: AutomationRead) => {
              requests.push({ input, projectId });
              return Promise.resolve({} as AutomationReadSnapshot);
            },
            automationApply: (input: AutomationApplyInput) => {
              requests.push({ input, projectId });
              return Promise.resolve({} as AutomationApplyResult);
            },
          } as unknown as CoreGenerationClient;
          const access = CoreSessionAccess.of({
            use: (_operation, run, options) =>
              Effect.promise((signal) => {
                admissions += 1;
                projectId = options?.projectId;
                return run(client, signal);
              }),
            handshake: Effect.die("unused"),
          });
          const context = yield* Layer.build(
            live.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access))),
          );
          const core = Context.get(context, CoreModules);
          const read: AutomationRead = { kind: "automation", automation_id: "automation:a" };
          const list = {
            kind: "automations",
            include_deleted: false,
            search_query: "daily",
            window: { after: "cursor:next", first: 25 },
          } as const;
          const input: AutomationApplyInput = {
            operationId: "operation:delete",
            intent: {
              kind: "delete_automation",
              automation_id: "automation:a",
              expected_revision: 4,
            },
          };

          const rejected = yield* core.automation
            .read({ kind: "due_work", lane: "automations" }, undefined, "project:target")
            .pipe(Effect.provideService(CoreApplicationAgent, provenance), Effect.flip);
          assert.strictEqual(rejected.operation, "automation.read");
          assert.isFalse(rejected.retryable);
          assert.strictEqual(admissions, 0);
          assert.deepStrictEqual(requests, []);

          yield* core.automation
            .read(read, undefined, "project:target")
            .pipe(Effect.provideService(CoreApplicationAgent, provenance));
          yield* core.automation
            .read(list, undefined, "project:target")
            .pipe(Effect.provideService(CoreApplicationAgent, provenance));
          yield* core.automation
            .apply(input, undefined, "project:target")
            .pipe(Effect.provideService(CoreApplicationAgent, provenance));
          yield* core.automation.read(read, undefined, "project:host");
          yield* core.automation.read(list, undefined, "project:host");
          yield* core.automation.apply(input, undefined, "project:host");

          assert.deepStrictEqual(requests, [
            {
              projectId: "project:actor",
              input: { kind: "agent_automation", automation_id: "automation:a", provenance },
            },
            {
              projectId: "project:actor",
              input: {
                kind: "agent_automations",
                search_query: "daily",
                window: { after: "cursor:next", first: 25 },
                provenance,
              },
            },
            {
              projectId: "project:actor",
              input: {
                ...input,
                intent: { kind: "agent_command", provenance, intent: input.intent },
              },
            },
            { projectId: "project:host", input: read },
            { projectId: "project:host", input: list },
            { projectId: "project:host", input },
          ]);
        }),
      ),
  );
});

describe("CoreMinimumCommit", () => {
  const describe = describeCoreMinimumCommit;
  describe("CoreMinimumCommit", () => {
    it.effect("returns the first snapshot that reaches the causal commit", () =>
      Effect.gen(function* () {
        const reads = yield* Ref.make(0);
        const read = Ref.updateAndGet(reads, (value) => value + 1).pipe(
          Effect.map((attempt) => ({ store_epoch: "epoch-a", commit_head: attempt })),
        );
        const fiber = yield* readCoreSnapshotAtLeast(read, "epoch-a", 3).pipe(Effect.forkChild);

        yield* TestClock.adjust("10 millis");

        assert.deepEqual(yield* Fiber.join(fiber), { store_epoch: "epoch-a", commit_head: 3 });
        assert.strictEqual(yield* Ref.get(reads), 3);
      }),
    );

    it.effect("reports the last observed commit when the projection stays behind", () =>
      Effect.gen(function* () {
        const fiber = yield* readCoreSnapshotAtLeast(
          Effect.succeed({ store_epoch: "epoch-a", commit_head: 7 }),
          "epoch-a",
          9,
        ).pipe(Effect.forkChild);

        yield* TestClock.adjust("250 millis");
        const exit = yield* Fiber.await(fiber);

        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          assert.isTrue(Schema.is(CoreMinimumCommitTimeout)(error));
          if (Schema.is(CoreMinimumCommitTimeout)(error)) {
            assert.strictEqual(error.minimumCommitSeq, 9);
            assert.strictEqual(error.observedCommitSeq, 7);
          }
        }
      }),
    );

    it.effect("fails store replacement without retrying", () =>
      Effect.gen(function* () {
        const reads = yield* Ref.make(0);
        const exit = yield* readCoreSnapshotAtLeast(
          Ref.updateAndGet(reads, (value) => value + 1).pipe(
            Effect.map(() => ({ store_epoch: "epoch-b", commit_head: 100 })),
          ),
          "epoch-a",
          2,
        ).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.isTrue(Schema.is(CoreStoreEpochMismatch)(Cause.squash(exit.cause)));
        }
        assert.strictEqual(yield* Ref.get(reads), 1);
      }),
    );

    it.effect("returns an expected domain failure without treating it as projection lag", () =>
      Effect.gen(function* () {
        const result = yield* readCoreProjectionAtLeast(
          Effect.succeed({ ok: false as const, error: "page_not_found" }),
          "epoch-a",
          9,
          () => null,
        );

        assert.deepEqual(result, { ok: false, error: "page_not_found" });
      }),
    );

    it.effect("stops polling when the caller is interrupted", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const reads = yield* Ref.make(0);
        const read = Ref.updateAndGet(reads, (value) => value + 1).pipe(
          Effect.tap(() => Deferred.succeed(started, undefined)),
          Effect.map(() => ({ store_epoch: "epoch-a", commit_head: 0 })),
        );
        const fiber = yield* readCoreSnapshotAtLeast(read, "epoch-a", 10).pipe(Effect.forkChild);
        yield* Deferred.await(started);

        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust("1 second");

        assert.strictEqual(yield* Ref.get(reads), 1);
      }),
    );
  });
});

describe("operation-identity", () => {
  const it = itoperationidentity;
  const RECEIPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

  describe("bounded due-work identities", () => {
    it("reuses one identity for retries of the same work episode and rotates after expiry", () => {
      const issuedAt = 1_800_000_000_000;
      const first = createDueWorkOperationId(
        "automation.claim-due",
        "work:stable",
        { limit: 10 },
        issuedAt,
      );
      const retry = createDueWorkOperationId(
        "automation.claim-due",
        "work:stable",
        { limit: 10 },
        issuedAt + 10_000,
      );
      const differentEpisode = createDueWorkOperationId(
        "automation.claim-due",
        "work:next",
        { limit: 10 },
        issuedAt + 10_000,
      );
      const afterExpiry = createDueWorkOperationId(
        "automation.claim-due",
        "work:stable",
        { limit: 10 },
        issuedAt + RECEIPT_WINDOW_MS,
      );

      expect(retry).toBe(first);
      expect(differentEpisode).not.toBe(first);
      expect(afterExpiry).not.toBe(first);
    });
  });

  describe("bounded child-operation identities", () => {
    it("derives a restart-stable identity from a durable parent coordinate", () => {
      const issuedAt = 1_800_000_000_000;
      const identity = ["thread:one", "turn:one", "call:one", "create_pages"];

      const first = createStableOperationId("nodex-agent.create-pages", issuedAt, identity);
      const replay = createStableOperationId("nodex-agent.create-pages", issuedAt, [...identity]);
      const otherCall = createStableOperationId("nodex-agent.create-pages", issuedAt, [
        "thread:one",
        "turn:one",
        "call:two",
        "create_pages",
      ]);

      expect(replay).toBe(first);
      expect(otherCall).not.toBe(first);
      expect(first).toMatch(
        /^nodexop:v1:1800000000000:1800604800000:nodex-agent\.create-pages:[a-f0-9]{64}$/u,
      );
    });
  });
});
