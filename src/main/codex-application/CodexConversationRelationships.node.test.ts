import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexConversationSnapshot } from "../../shared/types";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import {
  CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_PAGES,
  CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_RESULTS,
  CODEX_CONVERSATION_RELATIONSHIP_MAX_ACTIVE_REPAIRS,
  make,
} from "./CodexConversationRelationships";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import {
  makeConversationEntityStateRegistry,
  type ConversationEntityStateRegistry,
} from "./internal/ConversationEntityState";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";

type CoreThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "thread" }
>["thread"];

const conversation = {
  threadId: "parent",
  projectId: "project-1",
  source: null,
  threadName: "Parent",
  threadPreview: "",
  modelProvider: "openai",
  cwd: "/repo",
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  linkedAt: "2026-08-24T00:00:00.000Z",
  resumeState: "resumed",
  turns: [],
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
  pendingSteers: [],
  backgroundTerminalRows: [],
  capabilityFlags: {
    canEditLastUserTurn: true,
    canForkFromTurn: true,
    canSearch: true,
    canCollapseTurns: true,
  },
} satisfies CodexConversationSnapshot;

const coreThread = (threadId: string, parentThreadId: string | null): CoreThread =>
  ({
    thread_id: threadId,
    project_id: "project-1",
    session_id: null,
    forked_from_id: null,
    parent_thread_id: parentThreadId,
    thread_source: parentThreadId ? "subagent" : null,
    service_name: null,
    agent_nickname: null,
    agent_role: null,
    agent_path: null,
    thread_name: null,
    thread_preview: "",
    backend_binding: { kind: "codex" },
    model_id: null,
    reasoning_effort: null,
    service_tier: null,
    execution_host_id: "local",
    cwd: "/repo",
    writable_roots: ["/repo"],
    managed_worktree_path: null,
    projectless_output_directory: null,
    projectless_workspace_browser_root: null,
    status: { status_type: "notLoaded", active_flags: [] },
    archived: false,
    pinned_order: null,
    has_unread_turn: false,
    dynamic_tool_catalogs: [],
    created_at: 1,
    updated_at: 2,
    recency_at: 2,
    linked_at: "2026-08-24T00:00:00.000Z",
  }) satisfies CoreThread;

const buildRelationships = Effect.fn("CodexConversationRelationshipsTest.build")(function* (input: {
  readonly scope: Scope.Scope;
  readonly published: CodexApplicationEvent[];
  readonly thread?: (threadId: string) => CoreThread;
  readonly children: (parentThreadId: string) => readonly CoreThread[];
  readonly childWindow?: (input: {
    readonly parentThreadId: string;
    readonly after: string | null;
    readonly first: number;
  }) => { readonly items: readonly CoreThread[]; readonly nextCursor: string | null };
  readonly directory: CodexThreadDirectory["Service"];
  readonly entities?: ConversationEntityStateRegistry;
  readonly beforeChildRead?: Effect.Effect<void>;
}) {
  const entities = input.entities ?? makeConversationEntityStateRegistry();
  const current = (threadId: string) => {
    if (input.entities) return entities.current(threadId);
    const existing = entities.current(threadId);
    if (existing) return existing;
    const entity = entities.acquire(threadId);
    entity.acceptCanonicalState(conversationFixture(threadId));
    entity.installSnapshot({ ...conversation, threadId });
    return entity;
  };
  const workspace: CoreModuleClients["workspace"] = {
    read: (read) => {
      if (read.kind === "thread") {
        return Effect.succeed({
          value: {
            kind: "thread",
            thread: input.thread?.(read.thread_id) ?? coreThread(read.thread_id, null),
          },
        } as never);
      }
      if (read.kind === "child_thread_window") {
        const page = input.childWindow?.({
          parentThreadId: read.parent_thread_id,
          after: read.window.after ?? null,
          first: read.window.first ?? 200,
        }) ?? {
          items: input.children(read.parent_thread_id),
          nextCursor: null,
        };
        return (input.beforeChildRead ?? Effect.void).pipe(
          Effect.as({
            value: {
              kind: "child_thread_window",
              threads: { items: page.items, next_cursor: page.nextCursor },
            },
          } as never),
        );
      }
      return Effect.die(`Unexpected Core read '${read.kind}'`);
    },
    apply: () => Effect.die("unused"),
  };
  const runCommand: ConversationEntityMap["Service"]["runCommand"] = (_threadId, operation) =>
    operation;
  return yield* make.pipe(
    Effect.provideService(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: (event) => input.published.push(event),
      }),
    ),
    Effect.provideService(CodexThreadDirectory, input.directory),
    Effect.provideService(
      ConversationEntityMap,
      ConversationEntityMap.of({
        registerThreadMetadata: () => {},
        readThreadMetadata: () => null,
        subscribeRetired: entities.subscribeRetired,
        current,
        runCommand,
      } as unknown as ConversationEntityMap["Service"]),
    ),
    Effect.provideService(
      CoreModules,
      CoreModules.of({ workspace } as unknown as CoreModuleClients),
    ),
    Effect.provideService(Scope.Scope, input.scope),
  );
});

it.effect("publishes canonical-only child approvals on their parent's execution host", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const entities = makeConversationEntityStateRegistry();
    const parent = entities.acquire("parent");
    parent.acceptCanonicalState(conversationFixture("parent"));
    const child = entities.acquire("child");
    child.acceptCanonicalState({
      ...conversationFixture("child", [turnFixture("child-turn", "inProgress")]),
      parentThreadId: "parent",
      title: "Canonical child",
      agentNickname: "Scout",
      threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
      requests: [
        {
          id: 17,
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            threadId: "child",
            turnId: "child-turn",
            itemId: "command",
            environmentId: null,
            startedAtMs: 3,
            command: "pwd",
          },
        },
      ],
    });
    const published: CodexApplicationEvent[] = [];
    const relationships = yield* buildRelationships({
      scope,
      entities,
      published,
      thread: (threadId) => ({
        ...coreThread(threadId, null),
        project_id: null,
        execution_host_id: "remote-a",
      }),
      children: () => [{ ...coreThread("child", "parent"), thread_name: "Durable child" }],
      directory: CodexThreadDirectory.of({
        resolve: () => Effect.die("No metadata repair needed"),
      } as unknown as CodexThreadDirectory["Service"]),
    });
    const memberships = yield* relationships.refresh("parent");
    assert.strictEqual(memberships.length, 1);
    assert.strictEqual(memberships[0]?.actorName, "Canonical child");
    assert.strictEqual(memberships[0]?.statusType, "active");
    assert.strictEqual(memberships[0]?.role, "childApproval");
    assert.deepEqual(published, [
      {
        kind: "hostMessage",
        value: {
          type: "sharedObjectUpdated",
          hostId: "remote-a",
          object: {
            objectType: "conversationChildMemberships",
            objectId: "parent",
            value: { parentThreadId: "parent", childMemberships: [...memberships] },
          },
        },
      },
    ]);
    assert.isNull(parent.readSnapshot());
    assert.isNull(child.readSnapshot());
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "repairs unresolved durable metadata even when the resident child has a friendly title",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const entities = makeConversationEntityStateRegistry();
      entities.acquire("parent").acceptCanonicalState(conversationFixture("parent"));
      entities.acquire("child").acceptCanonicalState({
        ...conversationFixture("child"),
        title: "Resident child",
        parentThreadId: "parent",
      });
      let repairs = 0;
      let released = 0;
      const relationships = yield* buildRelationships({
        scope,
        entities,
        published: [],
        children: () => [coreThread("child", "parent")],
        directory: CodexThreadDirectory.of({
          resolve: () =>
            Effect.sync(() => {
              repairs += 1;
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  released += 1;
                }),
              ),
            ),
        } as unknown as CodexThreadDirectory["Service"]),
      });
      const memberships = yield* relationships.refresh("parent");
      yield* Effect.yieldNow;
      assert.strictEqual(memberships[0]?.actorName, "Resident child");
      assert.strictEqual(repairs, 1);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(released, 1);
    }),
);

it.effect(
  "releases pending metadata repair when its parent retires while the Profile stays open",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const registry = makeConversationEntityStateRegistry();
      let subscriptions = 0;
      const entities: ConversationEntityStateRegistry = {
        ...registry,
        subscribeRetired: (listener) => {
          subscriptions += 1;
          const subscription = registry.subscribeRetired(listener);
          return {
            [Symbol.dispose]: () => {
              subscriptions -= 1;
              subscription[Symbol.dispose]();
            },
          };
        },
      };
      const parent = entities.acquire("parent");
      parent.acceptCanonicalState(conversationFixture("parent"));
      let started = 0;
      let interrupted = 0;
      const relationships = yield* buildRelationships({
        scope,
        entities,
        published: [],
        children: () => [coreThread("child", "parent")],
        directory: CodexThreadDirectory.of({
          resolve: () =>
            Effect.sync(() => {
              started += 1;
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted += 1;
                }),
              ),
            ),
        } as unknown as CodexThreadDirectory["Service"]),
      });
      yield* relationships.refresh("parent");
      yield* Effect.yieldNow;
      assert.strictEqual(started, 1);
      assert.strictEqual(subscriptions, 1);
      entities.releaseGeneration("parent", parent.generation);
      yield* Effect.yieldNow;
      assert.strictEqual(interrupted, 1);
      assert.strictEqual(subscriptions, 0);
      assert.isNull(entities.current("parent"));
      entities.acquire("parent").acceptCanonicalState(conversationFixture("parent"));
      yield* relationships.refresh("parent");
      yield* Effect.yieldNow;
      assert.strictEqual(started, 2);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(interrupted, 2);
      assert.strictEqual(subscriptions, 0);
    }),
);

it.effect("does not publish old relationship work after the parent entity is replaced", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const entities = makeConversationEntityStateRegistry();
    const parent = entities.acquire("parent");
    parent.acceptCanonicalState(conversationFixture("parent"));
    parent.installSnapshot(conversation);
    const admitted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const published: CodexApplicationEvent[] = [];
    const relationships = yield* buildRelationships({
      scope,
      entities,
      published,
      children: () => [{ ...coreThread("child", "parent"), thread_name: "Child" }],
      beforeChildRead: Deferred.succeed(admitted, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
      directory: CodexThreadDirectory.of({
        resolve: () => Effect.die("No metadata repair needed"),
      } as unknown as CodexThreadDirectory["Service"]),
    });
    const fiber = yield* Effect.forkChild(relationships.refresh("parent"));
    yield* Deferred.await(admitted);
    entities.releaseGeneration("parent", parent.generation);
    entities.acquire("parent").acceptCanonicalState(conversationFixture("parent"));
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(yield* Fiber.join(fiber), []);
    assert.deepEqual(published, []);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("shares one metadata repair per child and interrupts it with the owner Scope", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const published: CodexApplicationEvent[] = [];
    let repairStarts = 0;
    let repairInterrupts = 0;
    const child = coreThread("child", "parent");
    const directory = CodexThreadDirectory.of({
      resolve: () =>
        Effect.sync(() => {
          repairStarts += 1;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => (repairInterrupts += 1))),
        ),
    } as unknown as CodexThreadDirectory["Service"]);
    const relationships = yield* buildRelationships({
      scope: ownerScope,
      published,
      children: (parentThreadId) => (parentThreadId === "parent" ? [child] : []),
      directory,
    });

    yield* relationships.refresh("parent");
    yield* relationships.refresh("parent");
    yield* Effect.yieldNow;

    assert.strictEqual(repairStarts, 1);
    assert.strictEqual(
      published.filter(
        (event) =>
          event.kind === "hostMessage" &&
          event.value.type === "sharedObjectUpdated" &&
          event.value.object.objectType === "conversationChildMemberships",
      ).length,
      2,
    );

    yield* Scope.close(ownerScope, Exit.void);
    assert.strictEqual(repairInterrupts, 1);
  }),
);

it.effect("caps concurrent metadata repairs across parents", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    let repairStarts = 0;
    let repairInterrupts = 0;
    const directory = CodexThreadDirectory.of({
      resolve: () =>
        Effect.sync(() => {
          repairStarts += 1;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => (repairInterrupts += 1))),
        ),
    } as unknown as CodexThreadDirectory["Service"]);
    const relationships = yield* buildRelationships({
      scope: ownerScope,
      published: [],
      children: (parentThreadId) =>
        Array.from({ length: CODEX_CONVERSATION_RELATIONSHIP_MAX_ACTIVE_REPAIRS + 1 }, (_, index) =>
          coreThread(`${parentThreadId}-child-${index}`, parentThreadId),
        ),
      directory,
    });

    yield* relationships.refresh("parent-a");
    yield* relationships.refresh("parent-b");
    yield* Effect.yieldNow;

    assert.strictEqual(repairStarts, CODEX_CONVERSATION_RELATIONSHIP_MAX_ACTIVE_REPAIRS);
    yield* Scope.close(ownerScope, Exit.void);
    assert.strictEqual(repairInterrupts, CODEX_CONVERSATION_RELATIONSHIP_MAX_ACTIVE_REPAIRS);
  }),
);

it.effect("hands metadata repair to the child's current parent generation", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    let repairStarts = 0;
    let repairInterrupts = 0;
    const directory = CodexThreadDirectory.of({
      resolve: () =>
        Effect.sync(() => {
          repairStarts += 1;
          return repairStarts;
        }).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Effect.succeed({
                  durable: {
                    threadId: "child",
                    parentThreadId: "new-parent",
                    threadName: null,
                    threadPreview: "",
                    modelProvider: "openai",
                    agentNickname: null,
                    agentRole: null,
                    agentPath: null,
                    statusType: "notLoaded",
                    archived: false,
                    createdAt: 1,
                    updatedAt: 2,
                  },
                } as never)
              : Effect.never,
          ),
          Effect.onInterrupt(() => Effect.sync(() => (repairInterrupts += 1))),
        ),
    } as unknown as CodexThreadDirectory["Service"]);
    const relationships = yield* buildRelationships({
      scope: ownerScope,
      published: [],
      children: (parentThreadId) => [coreThread("child", parentThreadId)],
      directory,
    });

    yield* relationships.refresh("old-parent");
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    assert.strictEqual(repairStarts, 2);
    yield* Scope.close(ownerScope, Exit.void);
    assert.strictEqual(repairInterrupts, 1);
  }),
);

it.effect("fails closed without publishing a partial projection when a child cursor repeats", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const published: CodexApplicationEvent[] = [];
    let childReads = 0;
    const relationships = yield* buildRelationships({
      scope: ownerScope,
      published,
      children: () => [],
      childWindow: () => {
        childReads += 1;
        return {
          items: [coreThread(`child-${childReads}`, "parent")],
          nextCursor: "stalled",
        };
      },
      directory: CodexThreadDirectory.of({ resolve: () => Effect.die("unused") } as never),
    });

    const result = yield* Effect.exit(relationships.refresh("parent"));

    assert.isTrue(Exit.isFailure(result));
    assert.strictEqual(childReads, 2);
    assert.deepEqual(published, []);
    yield* Scope.close(ownerScope, Exit.void);
  }),
);

it.effect("bounds a 10k-child relationship scan before it can retain every child", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const published: CodexApplicationEvent[] = [];
    let childReads = 0;
    const totalChildren = 10_000;
    const relationships = yield* buildRelationships({
      scope: ownerScope,
      published,
      children: () => [],
      childWindow: ({ after, first }) => {
        childReads += 1;
        const page = after === null ? 0 : Number(after);
        const start = page * first;
        const count = Math.min(first, totalChildren - start);
        return {
          items: Array.from({ length: Math.max(0, count) }, (_, index) =>
            coreThread(`child-${start + index}`, "parent"),
          ),
          nextCursor: start + count < totalChildren ? String(page + 1) : null,
        };
      },
      directory: CodexThreadDirectory.of({ resolve: () => Effect.die("unused") } as never),
    });

    const result = yield* Effect.exit(relationships.refresh("parent"));

    assert.isTrue(Exit.isFailure(result));
    assert.strictEqual(childReads, CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_PAGES);
    assert.isTrue(childReads * 200 <= CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_RESULTS);
    assert.deepEqual(published, []);
    yield* Scope.close(ownerScope, Exit.void);
  }),
);
