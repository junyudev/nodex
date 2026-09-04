import { EventEmitter } from "node:events";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import { createUuidV7 } from "../../shared/uuid-v7";
import type {
  LibraryModuleApplyRequest,
  LibraryModuleApplyResult,
  LibraryStructuralHistoryToken,
} from "../../shared/library-module";
import { LibraryModule, LibraryModuleError } from "../library-application/LibraryModule";
import { EditorHistoryRuntime, live } from "./EditorHistoryRuntime";
import { DatabaseModule } from "../database-application/DatabaseModule";
import { DesktopDocumentSessionRuntime } from "../core-client/desktop-document-sync-bridge";
import type { DatabaseApplyResultV2, DatabaseApplyV2 } from "../../shared/database-module-v2";
import type {
  BlockTransferCommandResult,
  BlockTransferIntent,
  BlockTransferUndoIntent,
} from "../../shared/block-transfer";

const access = { kind: "project" as const, projectId: "project:test" };
const request = (): LibraryModuleApplyRequest => ({
  operationId: createUuidV7(),
  storeEpoch: "epoch:test",
  operation: {
    kind: "apply_structural_edit",
    command: { kind: "release_history", tokens: [] },
  },
});
const rejected = {
  ok: false,
  error: { code: "revision_conflict", message: "Definitively not committed", retryable: true },
} satisfies LibraryModuleApplyResult;
const unknown = {
  ok: false,
  error: { code: "unknown", message: "Response unavailable", retryable: true },
} satisfies LibraryModuleApplyResult;
const databaseReceipt = (operationId: string): DatabaseApplyResultV2 => ({
  ok: true,
  localCommit: { status: "no_op", observed: { store_epoch: "epoch:test", commit_head: 7 } },
  value: {
    operationId,
    projectId: access.projectId,
    libraryId: "library:test",
    storeEpoch: "epoch:test",
    duplicate: true,
    operationKinds: [],
    operationOutcomes: [],
    affectedDatabaseIds: [],
    affectedDataSourceIds: [],
    affectedPageIds: [],
    affectedViewIds: [],
    committedRevisions: {},
    commitSeq: 7,
    committedAt: "2026-09-05T00:00:00.000Z",
  },
});
const token = (recipeOperationId: string): LibraryStructuralHistoryToken => ({
  recipeOperationId,
  recipeHash: "a".repeat(64),
  storeEpoch: "epoch:test",
});
const reversed = (): LibraryModuleApplyResult => ({
  ok: true,
  localCommit: { status: "no_op", observed: { store_epoch: "epoch:test", commit_head: 0 } },
  value: {
    operationId: createUuidV7(),
    profileId: "profile:test",
    libraryId: "library:test",
    storeEpoch: "epoch:test",
    operationKind: "reverse_structural_edit",
    duplicate: false,
    didMutate: false,
    createdTarget: null,
    canvasMutation: null,
    structuralEdit: {
      operationKind: "reverse_structural_edit",
      history: token("inverse"),
      sourceRootBlockIds: [],
      resultRootBlockIds: [],
      copiedBlockIds: {},
      copiedDocumentIds: {},
      documentCommits: [],
      affectedPageIds: [],
      affectedDatabaseIds: [],
      clipboard: null,
      supersededHistoryRecipeOperationIds: [],
      resume: null,
    },
    affectedParentKeys: [],
    affectedPageIds: [],
    affectedDatabaseIds: [],
    affectedViewIds: [],
    committedRevisions: {},
    commitSeq: 0,
    committedAt: "2026-09-04T00:00:00.000Z",
  },
});
const target = () => Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
type HistoryTarget = Parameters<EditorHistoryRuntime["Service"]["apply"]>[0];
const fixture = (
  port: Pick<LibraryModule["Service"], "apply" | "closeEditorHistoryOwner">,
  database: Partial<DatabaseModule["Service"]> = {},
  documents: Partial<DesktopDocumentSessionRuntime["Service"]> = {},
) =>
  live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(LibraryModule, port as LibraryModule["Service"]),
        Layer.succeed(DatabaseModule, database as DatabaseModule["Service"]),
        Layer.succeed(
          DesktopDocumentSessionRuntime,
          documents as DesktopDocumentSessionRuntime["Service"],
        ),
      ),
    ),
  );

it.effect(
  "Database recovery outlives a lost waiter and closed renderer without changing its request",
  () =>
    Effect.gen(function* () {
      const calls: DatabaseApplyV2[] = [];
      const started = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<void>();
      const context = yield* Layer.build(
        fixture(
          {
            apply: () => Effect.succeed(rejected),
            closeEditorHistoryOwner: () => Effect.void,
          },
          {
            apply: (received) =>
              Effect.gen(function* () {
                calls.push(structuredClone(received));
                if (calls.length <= 2) {
                  yield* Deferred.succeed(started, undefined);
                  return unknown;
                }
                yield* Deferred.succeed(recovered, undefined);
                return databaseReceipt(received.operationId);
              }),
          },
        ),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target();
      const original: DatabaseApplyV2 = {
        operationId: createUuidV7(),
        projectId: access.projectId,
        storeEpoch: "epoch:test",
        actor: {},
        operations: [],
      };
      const expected = structuredClone(original);
      const waiting = yield* history
        .applyDatabase(window as unknown as HistoryTarget, original)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(waiting);
      window.emit("render-process-gone");
      Object.assign(original, { storeEpoch: "changed-after-ingress" });
      yield* TestClock.adjust("100 millis");
      yield* TestClock.adjust("200 millis");
      yield* Deferred.await(recovered);
      assert.deepEqual(calls, [expected, expected, expected]);
    }),
);

it.effect(
  "Database duplicate waiters share one admitted attempt and reject changed identities",
  () =>
    Effect.gen(function* () {
      let writes = 0;
      const response = yield* Deferred.make<DatabaseApplyResultV2>();
      const context = yield* Layer.build(
        fixture(
          {
            apply: () => Effect.succeed(rejected),
            closeEditorHistoryOwner: () => Effect.void,
          },
          {
            apply: () =>
              Effect.gen(function* () {
                writes++;
                return yield* Deferred.await(response);
              }),
          },
        ),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target() as unknown as HistoryTarget;
      const original: DatabaseApplyV2 = {
        operationId: createUuidV7(),
        projectId: access.projectId,
        storeEpoch: "epoch:test",
        actor: {},
        operations: [],
      };
      const first = yield* history.applyDatabase(window, original).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const second = yield* history
        .applyDatabase(window, structuredClone(original))
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const collision = yield* history.applyDatabase(window, {
        ...original,
        projectId: "project:other",
      });
      assert.isFalse(collision.ok);
      assert.equal(writes, 1);
      const receipt = databaseReceipt(original.operationId);
      yield* Deferred.succeed(response, receipt);
      assert.deepEqual(yield* Fiber.join(first), receipt);
      assert.deepEqual(yield* Fiber.join(second), receipt);
    }),
);

it.effect.each(["library_database", "transfer", "reverse_transfer"] as const)(
  "%s retains unknown results after renderer loss",
  (kind) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const owners: (string | undefined)[] = [];
      let closedOwner: string | undefined;
      const terminated = {
        ok: false as const,
        error: {
          code: "project_not_found" as const,
          message: "Project removed",
          retryable: false,
          reloadRequired: true,
        },
      };
      const send = (received: object, owner?: string) =>
        Effect.sync(() => {
          calls.push(JSON.stringify(received));
          owners.push(owner);
          if (calls.length > 1) return terminated;
          return { ...unknown, error: { ...unknown.error, reloadRequired: false } };
        });
      const context = yield* Layer.build(
        fixture(
          {
            apply: () => Effect.succeed(rejected),
            closeEditorHistoryOwner: (owner) =>
              Effect.sync(() => {
                closedOwner = owner;
              }),
          },
          { applyLibrary: send },
          { transferBlocks: send, undoBlockTransfer: send },
        ),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target();
      const common = {
        operationId: createUuidV7(),
        projectId: access.projectId,
        storeEpoch: "epoch:test",
      };
      const transfer: BlockTransferIntent = {
        ...common,
        actor: {},
        mode: "move",
        rootBlockIds: ["block:test"],
        causalDependencies: [],
        source: { kind: "document", documentId: "document:test" },
        target: { kind: "library", libraryId: "library:test" },
        promotionPolicy: "literal",
      };
      const reverse: BlockTransferUndoIntent = {
        ...common,
        token: {
          transferOperationId: "transfer:test",
          recipeHash: "a".repeat(64),
          storeEpoch: common.storeEpoch,
        },
      };
      const targetWindow = window as unknown as HistoryTarget;
      const action =
        kind === "library_database"
          ? history.applyLibraryDatabase(targetWindow, {
              operationId: common.operationId,
              storeEpoch: common.storeEpoch,
              operations: [],
            })
          : kind === "transfer"
            ? history.transferBlocks(targetWindow, transfer)
            : history.reverseBlockTransfer(targetWindow, reverse);
      const waiting = yield* action.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      window.emit("destroyed");
      yield* TestClock.adjust("100 millis");
      assert.deepEqual(yield* Fiber.join(waiting), terminated);
      assert.equal(calls.length, 2);
      assert.equal(calls[0], calls[1]);
      if (kind !== "library_database") {
        assert.isString(closedOwner);
        assert.deepEqual(owners, [closedOwner, closedOwner]);
      }
    }),
);

it.effect(
  "Database admission rejects stale generations and oversized requests before sending",
  () =>
    Effect.gen(function* () {
      let writes = 0;
      const context = yield* Layer.build(
        fixture(
          {
            apply: () => Effect.succeed(rejected),
            closeEditorHistoryOwner: () => Effect.void,
          },
          {
            apply: () =>
              Effect.sync(() => {
                writes++;
                return rejected;
              }),
          },
        ),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target();
      const original: DatabaseApplyV2 = {
        operationId: createUuidV7(),
        projectId: access.projectId,
        storeEpoch: "epoch:test",
        actor: {},
        operations: [],
      };
      const stale = history.applyDatabase(window as unknown as HistoryTarget, original);
      window.emit("render-process-gone");
      assert.isFalse((yield* stale).ok);
      assert.isFalse(
        (yield* history.applyDatabase(window as unknown as HistoryTarget, {
          ...original,
          actor: { payload: "x".repeat(32 * 1024 * 1024) },
        })).ok,
      );
      assert.equal(writes, 0);
      yield* history.applyDatabase(window as unknown as HistoryTarget, original);
      assert.equal(writes, 1);
    }),
);

it.effect.each([true, false])(
  "abandoned Promotion resolves and releases its capability while the window remains open, symmetric: %s",
  (symmetric) =>
    Effect.gen(function* () {
      const response = yield* Deferred.make<BlockTransferCommandResult>();
      const started = yield* Deferred.make<void>();
      const cleanup = yield* Deferred.make<LibraryModuleApplyRequest>();
      const calls: BlockTransferIntent[] = [];
      const context = yield* Layer.build(
        fixture(
          {
            apply: (scope, received) =>
              Effect.gen(function* () {
                assert.deepEqual(scope, access);
                yield* Deferred.succeed(cleanup, received);
                return rejected;
              }),
            closeEditorHistoryOwner: () => Effect.void,
          },
          {},
          {
            transferBlocks: (received) =>
              Effect.gen(function* () {
                calls.push(received);
                if (calls.length === 1) {
                  yield* Deferred.succeed(started, undefined);
                  return { ...unknown, error: { ...unknown.error, reloadRequired: false } };
                }
                return yield* Deferred.await(response);
              }),
          },
        ),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target() as unknown as HistoryTarget;
      const original: BlockTransferIntent = {
        operationId: createUuidV7(),
        projectId: access.projectId,
        storeEpoch: "epoch:test",
        actor: {},
        mode: "move",
        rootBlockIds: ["block:test"],
        causalDependencies: [],
        source: { kind: "document", documentId: "document:test" },
        target: { kind: "library", libraryId: "library:test" },
        promotionPolicy: "literal",
      };
      const expected = structuredClone(original);
      const waiting = yield* history.transferBlocks(window, original).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      assert.deepEqual(yield* history.handoffAbandonTransfer(window, original), { accepted: true });
      yield* Fiber.interrupt(waiting);
      Object.assign(original, { rootBlockIds: ["changed-after-handoff"] });
      assert.isFalse(yield* Deferred.isDone(cleanup));
      yield* TestClock.adjust("100 millis");
      yield* Deferred.succeed(response, {
        ok: true,
        localCommit: { status: "no_op", observed: { store_epoch: "epoch:test", commit_head: 1 } },
        value: {
          ...expected,
          duplicate: true,
          sourceRootBlockIds: ["block:test"],
          resultRootBlockIds: ["block:test"],
          copiedBlockIds: {},
          transformationEvidence: [],
          finalLocations: {},
          finalLocationRevisions: {},
          documentCommits: [],
          affectedDatabaseBlockIds: [],
          commitSeq: 1,
          committedAt: "2026-09-05T00:00:00Z",
          history: symmetric ? token(expected.operationId) : null,
          undoToken: {
            transferOperationId: expected.operationId,
            recipeHash: "a".repeat(64),
            storeEpoch: "epoch:test",
          },
        },
      });
      assert.deepEqual((yield* Deferred.await(cleanup)).operation, {
        kind: "apply_structural_edit",
        command: { kind: "release_history", tokens: [token(expected.operationId)] },
      });
      assert.deepEqual(calls, [expected, expected]);
    }),
);

it.effect.each(["forward", "inverse"] as const)(
  "%s abandonment waits for the exact outcome before releasing capabilities",
  (direction) =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<LibraryModuleApplyResult>();
      const cleanup = yield* Deferred.make<LibraryModuleApplyRequest>();
      const calls: LibraryModuleApplyRequest[] = [];
      const context = yield* Layer.build(
        fixture({
          apply: (_access, received) =>
            Effect.gen(function* () {
              calls.push(received);
              if (
                !(
                  received.operation.kind === "apply_structural_edit" &&
                  received.operation.command.kind === "release_history"
                )
              )
                return yield* Deferred.await(outcome);
              yield* Deferred.succeed(cleanup, received);
              return rejected;
            }),
          closeEditorHistoryOwner: () => Effect.void,
        }),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target() as unknown as HistoryTarget;
      const original: LibraryModuleApplyRequest = {
        ...request(),
        operation:
          direction === "inverse"
            ? { kind: "reverse_structural_edit", token: token("original") }
            : {
                kind: "apply_structural_edit",
                command: {
                  kind: "delete_selection",
                  selection: {
                    sourceDocumentId: "document:test",
                    sourceHead: { documentId: "document:test", generation: 1, expectedHeadSeq: 1 },
                    rootBlockIds: ["block:test"],
                  },
                  reason: { kind: "delete" },
                  direction: "forward",
                },
              },
      };
      const waiting = yield* history.apply(window, access, original).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.deepEqual(yield* history.handoffAbandon(window, access, original), { accepted: true });
      yield* Fiber.interrupt(waiting);
      assert.deepEqual(calls, [original]);
      assert.isFalse(yield* Deferred.isDone(cleanup));
      yield* Deferred.succeed(outcome, reversed());
      const released = yield* Deferred.await(cleanup);
      assert.deepEqual(released.operation, {
        kind: "apply_structural_edit",
        command: {
          kind: "release_history",
          tokens:
            direction === "inverse" ? [token("original"), token("inverse")] : [token("inverse")],
        },
      });
      assert.equal(calls.length, 2);
    }),
);

it.effect(
  "release handoff completes before Core responds, without inventing a commit receipt",
  () =>
    Effect.gen(function* () {
      const blocked = yield* Deferred.make<LibraryModuleApplyResult>();
      const context = yield* Layer.build(
        fixture({
          apply: () => Deferred.await(blocked),
          closeEditorHistoryOwner: () => Effect.void,
        }),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target();
      const handedOff = yield* history.handoffRelease(
        window as unknown as HistoryTarget,
        access,
        request(),
      );
      assert.deepEqual(handedOff, { accepted: true });
      const localRequest: LibraryModuleApplyRequest = {
        ...request(),
        operation: {
          kind: "apply_structural_edit",
          command: {
            kind: "set_local_history_retention",
            retention: {
              surfaceId: "surface",
              documentId: "document",
              generation: 1,
              revision: 2,
              blockIds: [],
              retainDocument: false,
              closed: false,
            },
          },
        },
      };
      assert.deepEqual(
        (yield* history.handoffRelease(window as unknown as HistoryTarget, access, localRequest))
          .accepted,
        false,
      );
      const closed: LibraryModuleApplyRequest = {
        ...request(),
        operation: {
          kind: "apply_structural_edit",
          command: {
            kind: "set_local_history_retention",
            retention: {
              surfaceId: "surface",
              documentId: "document",
              generation: 1,
              revision: 3,
              blockIds: [],
              retainDocument: false,
              closed: true,
            },
          },
        },
      };
      assert.deepEqual(
        yield* history.handoffRelease(window as unknown as HistoryTarget, access, closed),
        { accepted: true },
      );
      assert.equal(yield* Deferred.isDone(blocked), false);
      window.emit("destroyed");
    }),
);

it.effect.each(["revision_conflict", "recovery_required"] as const)(
  "Main retains the exact unknown attempt until %s after its renderer waiter is interrupted",
  (code) =>
    Effect.gen(function* () {
      const calls: Array<{ request: LibraryModuleApplyRequest; owner: string | undefined }> = [];
      const reached = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const ended: string[] = [];
      const context = yield* Layer.build(
        fixture({
          apply: (_access, received, owner) =>
            Effect.gen(function* () {
              calls.push({ request: received, owner });
              if (calls.length === 1) {
                yield* Deferred.succeed(reached, undefined);
                return unknown;
              }
              yield* Deferred.succeed(completed, undefined);
              return { ...rejected, error: { ...rejected.error, code } };
            }),
          closeEditorHistoryOwner: (owner) =>
            Effect.sync(() => {
              ended.push(owner);
            }),
        }),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target();
      const original = request();
      const waiting = yield* history
        .apply(window as unknown as HistoryTarget, access, original)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(reached);
      yield* Fiber.interrupt(waiting);
      yield* TestClock.adjust("100 millis");
      yield* Deferred.await(completed);
      assert.equal(calls.length, 2);
      assert.strictEqual(calls[0]!.request, original);
      assert.strictEqual(calls[1]!.request, original);
      assert.equal(calls[0]!.owner, calls[1]!.owner);
      yield* TestClock.adjust("10 seconds");
      assert.equal(calls.length, 2);
      window.emit("destroyed");
      yield* Effect.yieldNow;
      assert.deepEqual(ended, [calls[0]!.owner]);
    }),
);

it.effect("an effect admitted by an old renderer cannot start in its replacement's lifetime", () =>
  Effect.gen(function* () {
    let writes = 0;
    const context = yield* Layer.build(
      fixture({
        apply: () =>
          Effect.sync(() => {
            writes++;
            return rejected;
          }),
        closeEditorHistoryOwner: () => Effect.void,
      }),
    );
    const history = Context.get(context, EditorHistoryRuntime);
    const window = target();
    const old = history.apply(window as unknown as HistoryTarget, access, request());
    window.emit("render-process-gone");
    const result = yield* old;
    assert.equal(result.ok, false);
    assert.equal(writes, 0);
    yield* history.apply(window as unknown as HistoryTarget, access, request());
    assert.equal(writes, 1);
  }),
);

it.effect(
  "same-document navigation keeps history; a new renderer generation closes only its old owner",
  () =>
    Effect.gen(function* () {
      const owners: string[] = [];
      const ended: string[] = [];
      const context = yield* Layer.build(
        fixture({
          apply: (_access, _request, owner) =>
            Effect.sync(() => {
              owners.push(owner!);
              return rejected;
            }),
          closeEditorHistoryOwner: (owner) =>
            Effect.sync(() => {
              ended.push(owner);
            }),
        }),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target();
      const apply = () => history.apply(window as unknown as HistoryTarget, access, request());
      yield* apply();
      window.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      yield* apply();
      window.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
      yield* apply();
      assert.deepEqual(owners, [owners[0], owners[0], owners[0]]);
      window.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      yield* apply();
      assert.notEqual(owners[3], owners[0]);
      window.emit("render-process-gone");
      yield* apply();
      assert.notEqual(owners[4], owners[3]);
      assert.deepEqual(ended, [owners[0], owners[3]]);
    }),
);

it.effect("cleanup retries independently with the same owner and close operation", () =>
  Effect.gen(function* () {
    const calls: string[][] = [];
    const attempted = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const context = yield* Layer.build(
      fixture({
        apply: () => Effect.succeed(rejected),
        closeEditorHistoryOwner: (owner, operationId) =>
          Effect.gen(function* () {
            calls.push([owner, operationId]);
            if (calls.length === 1) {
              yield* Deferred.succeed(attempted, undefined);
              return yield* new LibraryModuleError({
                operation: "close",
                cause: new Error("offline"),
              });
            }
            yield* Deferred.succeed(released, undefined);
          }),
      }),
    );
    const history = Context.get(context, EditorHistoryRuntime);
    const window = target();
    yield* history.apply(window as unknown as HistoryTarget, access, request());
    window.emit("destroyed");
    yield* Deferred.await(attempted);
    yield* TestClock.adjust("100 millis");
    yield* Deferred.await(released);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  }),
);

it.effect(
  "authoritative cleanup expiry renews the request without changing its closed lifetime",
  () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const expired = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const context = yield* Layer.build(
        fixture({
          apply: () => Effect.succeed(rejected),
          closeEditorHistoryOwner: (owner, operationId) =>
            Effect.gen(function* () {
              calls.push([owner, operationId]);
              if (calls.length === 1) {
                yield* Deferred.succeed(expired, undefined);
                return "identity_expired" as const;
              }
              yield* Deferred.succeed(released, undefined);
            }),
        }),
      );
      const history = Context.get(context, EditorHistoryRuntime);
      const window = target();
      yield* history.apply(window as unknown as HistoryTarget, access, request());
      window.emit("destroyed");
      yield* Deferred.await(expired);
      yield* TestClock.adjust("100 millis");
      yield* Deferred.await(released);
      assert.equal(calls[0]![0], calls[1]![0]);
      assert.notEqual(calls[0]![1], calls[1]![1]);
    }),
);
