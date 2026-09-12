import {
  CodexMainConversationResume,
  MainConversationResumeError,
} from "./CodexMainConversationResume";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import { createCodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexConversationRelationships } from "./CodexConversationRelationships";
import { conversationFixture } from "./conversation-test-fixture";
import { createCodexCanonicalWorkspacePermissionContext } from "../../shared/codex-conversation-state/codex-conversation-state";
import { CodexFreshThreadLaunchRuntime } from "./CodexFreshThreadLaunchRuntime";
import { make } from "./CodexConversationResumeRuntime";
import {
  CodexThreadDirectory,
  type CodexThreadDirectoryEntry,
  type CodexThreadDirectoryFidelity,
} from "./CodexThreadDirectory";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";

const threadId = "thread-resume";
const permissionContext = {
  requestedPermissions: createCodexCanonicalWorkspacePermissionContext([]),
  runtimeWorkspaceRootCandidates: null,
};
const conversation = (): CodexConversationSnapshot =>
  ({
    threadId,
    resumeState: "resumed",
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
  }) as unknown as CodexConversationSnapshot;

const entry = (
  snapshot: CodexConversationSnapshot | null,
  fidelity: CodexThreadDirectoryFidelity,
): CodexThreadDirectoryEntry =>
  ({
    fidelity,
    durable: { threadId, archived: false } as CodexThreadDirectoryEntry["durable"],
    summary: { threadId } as CodexThreadDirectoryEntry["summary"],
    canonical: null,
    snapshot,
  }) as CodexThreadDirectoryEntry;

const build = Effect.fn("CodexConversationResumeRuntimeTest.build")(function* (
  scope: Scope.Scope,
  resolve: CodexThreadDirectory["Service"]["resolve"],
  relationships: CodexConversationRelationships["Service"] = CodexConversationRelationships.of({
    refresh: () => Effect.succeed([]),
  }),
  directoryMethods: Partial<CodexThreadDirectory["Service"]> = {},
) {
  const context = yield* Layer.buildWithScope(conversationRuntimeMapLive, scope);
  const conversations = Context.get(context, ConversationEntityMap);
  const directory = CodexThreadDirectory.of({
    resolve,
    ...directoryMethods,
  } as CodexThreadDirectory["Service"]);
  const runtime = yield* make.pipe(
    Effect.provideService(CodexMainConversationResume, {
      resume: (id) =>
        resolve({ threadId: id, fidelity: "live" }).pipe(
          Effect.map((result) => ({
            status: "ready" as const,
            snapshot: result?.snapshot ?? null,
          })),
          Effect.mapError((cause) => new MainConversationResumeError({ threadId: id, cause })),
        ),
    }),
    Effect.provideService(CodexConversationRelationships, relationships),
    Effect.provideService(
      CodexFreshThreadLaunchRuntime,
      CodexFreshThreadLaunchRuntime.of({
        prepare: () => Effect.die("unused native preparation"),
        register: () => undefined,
        reservation: () => null,
        adopt: () => Effect.die("unused"),
        start: () => Effect.die("unused"),
        releaseRenderer: () => undefined,
        clear: () => undefined,
      }),
    ),
    Effect.provideService(CodexThreadDirectory, directory),
    Effect.provideService(ConversationEntityMap, conversations),
    Effect.provideService(Scope.Scope, scope),
  );
  return { conversations, runtime };
});

it.effect("coalesces identical canonical resume demand", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const release = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    let physicalRuns = 0;
    const harness = yield* build(scope, ({ fidelity }) => {
      if (fidelity === "durable") return Effect.succeed(null);
      physicalRuns += 1;
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(null),
      );
    });
    const first = yield* harness.runtime.resume({ threadId }).pipe(Effect.forkChild);
    const second = yield* harness.runtime.resume({ threadId }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    assert.strictEqual(physicalRuns, 1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("returns a hydrated snapshot when relationship projection fails", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const snapshot = conversation();
    const harness = yield* build(
      scope,
      ({ fidelity }) => Effect.succeed(entry(snapshot, fidelity)),
      CodexConversationRelationships.of({ refresh: () => Effect.die("projection unavailable") }),
    );

    assert.strictEqual((yield* harness.runtime.snapshot(threadId))?.threadId, threadId);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("a passive snapshot read does not resume a window-owned canonical document", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const reads: string[] = [];
    const harness = yield* build(scope, ({ fidelity }) => {
      reads.push(fidelity);
      if (fidelity !== "durable") return Effect.die("A snapshot read must not resume native work");
      return Effect.succeed(entry(null, fidelity));
    });
    const entity = harness.conversations.entity(threadId);
    const document = conversationFixture(threadId);
    entity.installFollowerCanonicalState(document);
    entity.setStreamRole("follower");

    assert.isNull(yield* harness.runtime.snapshot(threadId));
    assert.deepEqual(reads, ["durable"]);
    assert.strictEqual(entity.readCanonicalState(), document);
    assert.strictEqual(entity.readResumeState(), "resumed");
    assert.strictEqual(entity.read().streamRole, "follower");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("interrupts physical resume work when the owning Scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const started = yield* Deferred.make<void>();
    const harness = yield* build(scope, ({ fidelity }) =>
      fidelity === "durable"
        ? Effect.succeed(null)
        : Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const fiber = yield* harness.runtime.resume({ threadId }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual((yield* Fiber.await(fiber))._tag, "Failure");
  }),
);

it.effect(
  "rotates resume request identity without changing preparation and ignores late attempts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const capability = createCodexAppServerCapabilitySnapshot({
          hostId: "local",
          generation: 1,
          userAgent: "codex/0.148.0",
        });
        const summary = entry(null, "durable").summary;
        const accepted: ThreadResumeResponse[] = [];
        const requestedCwd = "/workspace/project/subdirectory";
        const requestedOptions: unknown[] = [];
        const options = {
          serviceTier: "priority",
          useAppServerPermissionDefault: true,
          preserveServerConfiguration: false,
        };
        const { runtime } = yield* build(scope, () => Effect.succeed(null), undefined, {
          prepareResume: (_id, _metadata, _overrides, options) => {
            const serviceTier = options?.serviceTier;
            requestedOptions.push(options);
            return Effect.succeed({
              params: { threadId, excludeTurns: true, serviceTier },
              requestedCwd,
              permissionContext,
              summary,
              capability,
            });
          },
          acceptRendererResume: (input) =>
            Effect.sync(() => {
              assert.strictEqual(input.requestedCwd, requestedCwd);
              accepted.push(input.response);
              return summary;
            }),
        });
        const prepared = yield* runtime.prepareRendererResume(
          threadId,
          10,
          undefined,
          undefined,
          options,
        );
        assert.deepEqual(requestedOptions, [options]);
        assert.strictEqual(prepared.params.serviceTier, "priority");
        const response = { thread: { id: threadId } } as ThreadResumeResponse;
        const observe = (requestId: string) =>
          runtime.observeRendererResume({
            senderId: 10,
            hostId: "local",
            requestId,
            params: prepared.params,
            response,
          });
        yield* observe(prepared.nativeRequestId);
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(runtime.retryRendererResume(prepared.receiptId, 11))),
        );
        const nextId = yield* runtime.retryRendererResume(prepared.receiptId, 10);
        assert.notStrictEqual(nextId, prepared.nativeRequestId);
        yield* observe(prepared.nativeRequestId);
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(runtime.acceptRendererResume(prepared.receiptId, 10))),
        );
        yield* observe(nextId);
        yield* runtime.acceptRendererResume(prepared.receiptId, 10);
        yield* runtime.acceptRendererResume(prepared.receiptId, 10);
        assert.deepEqual(accepted, [response]);
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(runtime.retryRendererResume(prepared.receiptId, 10))),
        );

        const removed = yield* runtime.prepareRendererResume(threadId, 10);
        runtime.clear(threadId);
        yield* runtime.observeRendererResume({
          senderId: 10,
          hostId: "local",
          requestId: removed.nativeRequestId,
          params: removed.params,
          response,
        });
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(runtime.retryRendererResume(removed.receiptId, 10))),
        );
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(runtime.acceptRendererResume(removed.receiptId, 10))),
        );
      }),
    ),
);

it.effect("does not renew a receipt while its observed response is being accepted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const summary = entry(null, "durable").summary;
      const capability = createCodexAppServerCapabilitySnapshot({
        hostId: "local",
        generation: 1,
        userAgent: "codex/0.148.0",
      });
      let accepted = 0;
      const { runtime } = yield* build(scope, () => Effect.succeed(null), undefined, {
        prepareResume: () =>
          Effect.succeed({
            params: { threadId, excludeTurns: true },
            requestedCwd: null,
            permissionContext,
            summary,
            capability,
          }),
        acceptRendererResume: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.andThen(
              Effect.sync(() => {
                accepted++;
                return summary;
              }),
            ),
          ),
      });
      const prepared = yield* runtime.prepareRendererResume(threadId, 10);
      yield* runtime.observeRendererResume({
        senderId: 10,
        hostId: "local",
        requestId: prepared.nativeRequestId,
        params: prepared.params,
        response: { thread: { id: threadId } } as ThreadResumeResponse,
      });
      const acceptance = yield* runtime
        .acceptRendererResume(prepared.receiptId, 10)
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runtime.retryRendererResume(prepared.receiptId, 10))),
      );
      yield* Fiber.interrupt(acceptance);
      const nextId = yield* runtime.retryRendererResume(prepared.receiptId, 10);
      assert.notStrictEqual(nextId, prepared.nativeRequestId);
      yield* runtime.observeRendererResume({
        senderId: 10,
        hostId: "local",
        requestId: nextId,
        params: prepared.params,
        response: { thread: { id: threadId } } as ThreadResumeResponse,
      });
      yield* Deferred.succeed(finish, undefined);
      assert.strictEqual(yield* runtime.acceptRendererResume(prepared.receiptId, 10), summary);
      assert.strictEqual(yield* runtime.acceptRendererResume(prepared.receiptId, 10), summary);
      assert.strictEqual(accepted, 1);
    }),
  ),
);

it.effect("accepts matching resume values after transport key reordering and commits once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      let accepted = 0;
      const summary = entry(null, "durable").summary;
      const capability = createCodexAppServerCapabilitySnapshot({
        hostId: "local",
        generation: 1,
        userAgent: "codex/0.140.0",
      });
      const { runtime } = yield* build(scope, () => Effect.die("no Main hydration"), undefined, {
        prepareResume: () =>
          Effect.succeed({
            params: {
              threadId,
              excludeTurns: true,
              config: { profiles: { selected: { model: "model", sandbox_mode: "read-only" } } },
            },
            requestedCwd: null,
            permissionContext,
            summary,
            capability,
          }),
        acceptRendererResume: () =>
          Effect.sync(() => {
            accepted++;
            return summary;
          }),
      });
      const prepared = yield* runtime.prepareRendererResume(threadId, 10);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runtime.acceptRendererResume(prepared.receiptId, 10))),
      );
      const response = { thread: { id: threadId } } as ThreadResumeResponse;
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            runtime.observeRendererResume({
              senderId: 11,
              requestId: prepared.nativeRequestId,
              hostId: "local",
              params: prepared.params,
              response,
            }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            runtime.observeRendererResume({
              senderId: 10,
              requestId: prepared.nativeRequestId,
              hostId: "local",
              params: { ...prepared.params, excludeTurns: false },
              response,
            }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            runtime.observeRendererResume({
              senderId: 10,
              requestId: prepared.nativeRequestId,
              hostId: "local",
              params: {
                ...prepared.params,
                config: {
                  profiles: { selected: { model: "model", sandbox_mode: "danger-full-access" } },
                },
              },
              response,
            }),
          ),
        ),
      );
      yield* runtime.observeRendererResume({
        senderId: 10,
        requestId: prepared.nativeRequestId,
        hostId: "local",
        params: {
          config: { profiles: { selected: { sandbox_mode: "read-only", model: "model" } } },
          excludeTurns: true,
          threadId,
        },
        response,
      });
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runtime.acceptRendererResume(prepared.receiptId, 11))),
      );
      yield* runtime.acceptRendererResume(prepared.receiptId, 10);
      yield* runtime.acceptRendererResume(prepared.receiptId, 10);
      assert.strictEqual(accepted, 1);
      runtime.releaseRendererResume(prepared.receiptId, 10);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runtime.acceptRendererResume(prepared.receiptId, 10))),
      );
    }),
  ),
);
