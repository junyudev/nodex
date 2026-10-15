import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { CoreAuthorizedDeliveryPacket } from "../core-client/types";
import { createCoreLocalCommitFixture } from "../core-client/testing/local-commit-fixture";
import {
  LocalCommitRuntimeError,
  make,
  type LocalCommitRuntimeOptions,
} from "./LocalCommitRuntime";

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

    assert.strictEqual((yield* harness.runtime.admit(sparse, "projection_live")).kind, "accepted");
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
    assert.strictEqual((yield* harness.runtime.admit(packet, "projection_live")).kind, "duplicate");
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
      (yield* harness.runtime.admit(commit(7, { projectionEffects: [validEnrichment] }), "tailer"))
        .kind,
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
