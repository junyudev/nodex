import { describe, expect, test } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import type {
  CodexConversationSnapshot,
  CodexCanonicalConversationState,
} from "../../shared/types";
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
import type { Thread, ThreadListParams, Turn } from "@nodex/codex-app-server-protocol/v2";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { discoverCodexSubagentDescendants } from "./CodexSubagentDiscovery";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import {
  extractCodexConversationRelationshipThreadIds,
  projectCodexConversationRelationships,
  type CodexConversationRelationshipThread,
} from "./CodexConversationRelationshipsProjection";

describe("CodexConversationRelationships", () => {
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
      canEditUserTurns: true,
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
      backend_binding: { driver: "codex", instanceId: "codex" },
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

  const buildRelationships = Effect.fn("CodexConversationRelationshipsTest.build")(
    function* (input: {
      readonly scope: Scope.Scope;
      readonly published: CodexApplicationEvent[];
      readonly eventStream?: Stream.Stream<CodexApplicationEvent>;
      readonly onPublish?: (event: CodexApplicationEvent) => void;
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
        admitToolOperation: () => Effect.die("Unexpected application tool admission"),
        recordAgentRun: () => Effect.die("Unexpected Agent attribution"),
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
            events: input.eventStream ?? Stream.empty,
            publish: (event) => {
              input.published.push(event);
              input.onPublish?.(event);
            },
          }),
        ),
        Effect.provideService(CodexThreadDirectory, input.directory),
        Effect.provideService(
          ConversationEntityMap,
          ConversationEntityMap.of({
            registerThreadMetadata: () => {},
            readThreadMetadata: () => null,
            subscribeRetired: entities.subscribeRetired,
            subscribeCanonicalMutations: entities.subscribeCanonicalMutations,
            forHost: entities.forHost,
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
    },
  );

  it.effect("publishes canonical-only child questions on their parent's execution host", () =>
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
        threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnUserInput"] },
        requests: [
          {
            id: 17,
            method: "item/tool/requestUserInput",
            params: {
              threadId: "child",
              turnId: "child-turn",
              itemId: "command",
              isBlocking: true,
              autoResolutionMs: null,
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: "Continue?",
                  isOther: false,
                  isSecret: false,
                  options: null,
                },
              ],
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
        assert.strictEqual(subscriptions, 2);
        entities.releaseGeneration("parent", parent.generation);
        yield* Effect.yieldNow;
        assert.strictEqual(interrupted, 1);
        assert.strictEqual(subscriptions, 1);
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
          Array.from(
            { length: CODEX_CONVERSATION_RELATIONSHIP_MAX_ACTIVE_REPAIRS + 1 },
            (_, index) => coreThread(`${parentThreadId}-child-${index}`, parentThreadId),
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

  it.effect(
    "fails closed without publishing a partial projection when a child cursor repeats",
    () =>
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

  it.effect(
    "publishes and clears a nested canonical question without opening any child transcript",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const entities = makeConversationEntityStateRegistry();
        const root = entities.acquire("parent");
        root.acceptCanonicalState(conversationFixture("parent"));
        const grandchild = entities.acquire("grandchild");
        grandchild.acceptCanonicalState({
          ...conversationFixture("grandchild", [turnFixture("nested-turn", "inProgress")]),
          parentThreadId: "child",
          agentNickname: "Reviewer",
          requests: [
            {
              id: 29,
              method: "item/tool/requestUserInput",
              params: {
                threadId: "grandchild",
                turnId: "nested-turn",
                itemId: "command",
                isBlocking: true,
                autoResolutionMs: null,
                questions: [
                  {
                    id: "choice",
                    header: "Choice",
                    question: "Continue?",
                    isOther: false,
                    isSecret: false,
                    options: null,
                  },
                ],
              },
            },
          ],
        });
        const bus = yield* PubSub.unbounded<CodexApplicationEvent>();
        const published: CodexApplicationEvent[] = [];
        const relationships = yield* buildRelationships({
          scope,
          entities,
          published,
          eventStream: Stream.fromPubSub(bus),
          onPublish: (event) => {
            PubSub.publishUnsafe(bus, event);
          },
          thread: (id) => ({
            ...coreThread(id, id === "grandchild" ? "child" : null),
            thread_name: id,
          }),
          children: (id) =>
            id === "parent" ? [{ ...coreThread("child", "parent"), thread_name: "Child" }] : [],
          directory: CodexThreadDirectory.of({
            resolve: (input: Parameters<CodexThreadDirectory["Service"]["resolve"]>[0]) => {
              assert.strictEqual(input.fidelity, "metadata");
              return Effect.never;
            },
          } as unknown as CodexThreadDirectory["Service"]),
        });
        yield* Effect.yieldNow;
        const memberships = yield* relationships.refresh("parent");
        assert.deepEqual(
          memberships
            .map((member) => [member.threadId, member.parentThreadId])
            .sort((a, b) => a[0]!.localeCompare(b[0]!)),
          [
            ["child", "parent"],
            ["grandchild", "child"],
          ],
        );
        assert.strictEqual(
          memberships.find((member) => member.threadId === "grandchild")?.pendingRequest?.request
            .requestId,
          29,
        );
        assert.strictEqual(
          memberships.find((member) => member.threadId === "grandchild")?.pendingRequest
            ?.requestItem,
          null,
        );
        assert.isNull(root.readSnapshot());
        assert.isNull(grandchild.readSnapshot());
        assert.isNull(entities.current("child"));
        const clearWatch = yield* Stream.fromPubSub(bus).pipe(
          Stream.filter(
            (event) =>
              event.kind === "hostMessage" &&
              event.value.type === "sharedObjectUpdated" &&
              event.value.object.objectType === "conversationChildMemberships" &&
              event.value.object.objectId === "parent" &&
              event.value.object.value.childMemberships.some(
                (member) => member.threadId === "grandchild" && member.pendingRequest === null,
              ),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        grandchild.replaceServerRequests([]);
        yield* Fiber.join(clearWatch);
        assert.isNull(grandchild.readSnapshot());
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "routes the first deep request through nonresident ancestors to an already open root",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const entities = makeConversationEntityStateRegistry();
        entities.acquire("parent").acceptCanonicalState(conversationFixture("parent"));
        const parentById: Record<string, string | null> = {
          parent: null,
          child: "parent",
          middle: "child",
          leaf: "middle",
        };
        const bus = yield* PubSub.unbounded<CodexApplicationEvent>();
        const relationships = yield* buildRelationships({
          scope,
          entities,
          published: [],
          eventStream: Stream.fromPubSub(bus),
          onPublish: (event) => {
            PubSub.publishUnsafe(bus, event);
          },
          thread: (id) => ({ ...coreThread(id, parentById[id] ?? null), thread_name: id }),
          children: (id) =>
            id === "parent" ? [{ ...coreThread("child", "parent"), thread_name: "Child" }] : [],
          directory: CodexThreadDirectory.of({
            resolve: (input: Parameters<CodexThreadDirectory["Service"]["resolve"]>[0]) => {
              assert.strictEqual(input.fidelity, "metadata");
              return Effect.never;
            },
          } as unknown as CodexThreadDirectory["Service"]),
        });
        yield* Effect.yieldNow;
        assert.deepEqual(
          (yield* relationships.refresh("parent")).map((member) => member.threadId),
          ["child"],
        );
        const visible = yield* Stream.fromPubSub(bus).pipe(
          Stream.filter(
            (event) =>
              event.kind === "hostMessage" &&
              event.value.type === "sharedObjectUpdated" &&
              event.value.object.objectType === "conversationChildMemberships" &&
              event.value.object.objectId === "parent" &&
              event.value.object.value.childMemberships.some(
                (member) =>
                  member.threadId === "leaf" && member.pendingRequest?.request.requestId === 31,
              ),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        entities.acquire("leaf").acceptCanonicalState({
          ...conversationFixture("leaf", [turnFixture("deep-turn", "inProgress")]),
          parentThreadId: "middle",
          requests: [
            {
              id: 31,
              method: "item/tool/requestUserInput",
              params: {
                threadId: "leaf",
                turnId: "deep-turn",
                itemId: "command",
                isBlocking: true,
                autoResolutionMs: null,
                questions: [
                  {
                    id: "choice",
                    header: "Choice",
                    question: "Continue?",
                    isOther: false,
                    isSecret: false,
                    options: null,
                  },
                ],
              },
            },
          ],
        });
        yield* Fiber.join(visible);
        assert.isNull(entities.current("middle"));
        assert.isNull(entities.current("child"));
        assert.isNull(entities.current("leaf")?.readSnapshot());
        yield* Scope.close(scope, Exit.void);
      }),
  );
});

describe("CodexSubagentDiscovery", () => {
  type Input = Parameters<typeof discoverCodexSubagentDescendants>[0];
  type GatewayThread = ClientRequestResponsesByMethod["thread/list"]["data"][number];
  type GatewayTurn = ClientRequestResponsesByMethod["thread/turns/list"]["data"][number];
  const child = (id: string, parentThreadId = "root") =>
    ({
      id,
      parentThreadId,
      model: null,
      reasoningEffort: null,
      environments: null,
      extra: null,
      sessionId: id,
      forkedFromId: null,
      attachedToThreadId: null,
      preview: id,
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 100,
      updatedAt: 120,
      recencyAt: 120,
      status: { type: "active", activeFlags: [] },
      path: null,
      cwd: "/repo",
      cliVersion: "test",
      originator: null,
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: parentThreadId,
            depth: 1,
            agent_path: `${parentThreadId}/${id}`,
            agent_nickname: id,
            agent_role: "explorer",
          },
        },
      },
      canAcceptDirectInput: true,
      threadSource: "subAgentThreadSpawn",
      agentNickname: id,
      agentRole: "explorer",
      gitInfo: null,
      name: id,
      daybreakEnabled: null,
      turns: [],
    }) satisfies Thread & GatewayThread;
  const turnFixture = (id: string) =>
    ({
      rootTurnId: null,
      id,
      status: "completed",
      items: [],
      itemsView: "full",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    }) satisfies Turn & GatewayTurn;
  const spawn = (threadId: string) =>
    ({
      ...turnFixture(`spawn-${threadId}`),
      items: [
        {
          type: "subAgentActivity",
          model: null,
          reasoningEffort: null,
          id: `activity-${threadId}`,
          kind: "started",
          agentThreadId: threadId,
          agentPath: `/root/${threadId}`,
        },
      ],
    }) satisfies Turn & GatewayTurn;
  const input = (overrides: Partial<Input> = {}): Input => ({
    rootThreadId: "root",
    rootCreatedAtMs: 100_000,
    listSupported: true,
    ancestorFilter: true,
    observedSpawnedThreadIds: () => [],
    isResident: () => false,
    list: () => Effect.succeed({ data: [], nextCursor: null }),
    read: () => Effect.die("Unexpected metadata repair"),
    turns: () => Effect.die("Unexpected transcript read"),
    ...overrides,
  });

  it.effect("finishes every metadata page without a discovery pass or overview size limit", () =>
    Effect.gen(function* () {
      const pages = 35;
      const params: ThreadListParams[] = [];
      const result = yield* discoverCodexSubagentDescendants(
        input({
          list: (request) =>
            Effect.sync(() => {
              params.push(request);
              const page = Number(request.cursor ?? 0);
              return {
                data: Array.from({ length: 200 }, (_, index) =>
                  child(`child-${page * 200 + index}`),
                ),
                nextCursor: page + 1 === pages ? null : `${page + 1}`,
              };
            }),
        }),
      );
      assert.isTrue(result.complete);
      assert.strictEqual(result.threads.length, 7_000);
      assert.strictEqual(params.length, pages);
      assert.isTrue(
        params.every(
          (p) => p.ancestorThreadId === "root" && p.limit === 200 && p.useStateDbOnly === true,
        ),
      );
    }),
  );

  it.effect(
    "only falls back from a first terminal state-db page with missing observed spawns",
    () =>
      Effect.gen(function* () {
        const requests: ThreadListParams[] = [];
        const result = yield* discoverCodexSubagentDescendants(
          input({
            observedSpawnedThreadIds: (parent) => (parent === "root" ? ["missing"] : []),
            list: (params) =>
              Effect.sync(() => {
                requests.push(params);
                return { data: params.useStateDbOnly ? [] : [child("missing")], nextCursor: null };
              }),
          }),
        );
        assert.isTrue(result.complete);
        assert.deepEqual(
          requests.map((p) => p.useStateDbOnly),
          [true, false],
        );
        let emptyRequests = 0;
        yield* discoverCodexSubagentDescendants(
          input({
            ancestorFilter: false,
            list: () =>
              Effect.sync(() => {
                emptyRequests++;
                return { data: [], nextCursor: null };
              }),
          }),
        );
        assert.strictEqual(emptyRequests, 1);
      }),
  );

  it.effect("repairs a missing observed child after terminal pagination without re-listing", () =>
    Effect.gen(function* () {
      const requests: ThreadListParams[] = [];
      const reads: string[] = [];
      const result = yield* discoverCodexSubagentDescendants(
        input({
          observedSpawnedThreadIds: (parent) => (parent === "root" ? ["missing"] : []),
          list: (params) =>
            Effect.sync(() => {
              requests.push(params);
              return params.cursor === null
                ? { data: [child("listed")], nextCursor: "last" }
                : { data: [], nextCursor: null };
            }),
          read: (id) =>
            Effect.sync(() => {
              reads.push(id);
              return child(id);
            }),
          turns: () => Effect.succeed({ data: [], nextCursor: null }),
        }),
      );
      assert.isTrue(result.complete);
      assert.deepEqual(
        requests.map((p) => [p.cursor, p.useStateDbOnly]),
        [
          [null, true],
          ["last", true],
        ],
      );
      assert.deepEqual(reads, ["missing"]);
      assert.deepEqual(
        result.threads.map((t) => t.id),
        ["listed", "missing"],
      );
    }),
  );

  it.effect("stops cyclic list cursors before topology repair and reports incomplete", () =>
    Effect.gen(function* () {
      const cursors: Array<string | null | undefined> = [];
      const result = yield* discoverCodexSubagentDescendants(
        input({
          observedSpawnedThreadIds: () => ["unresolved"],
          list: (params) =>
            Effect.sync(() => {
              cursors.push(params.cursor);
              return { data: [], nextCursor: params.cursor === "a" ? "b" : "a" };
            }),
        }),
      );
      assert.isFalse(result.complete);
      assert.deepEqual(cursors, [null, "a", "b"]);
    }),
  );

  it.effect("uses the root creation cutoff and skips unrelated direct-parent rows", () =>
    Effect.gen(function* () {
      const parents: Array<string | null | undefined> = [];
      const result = yield* discoverCodexSubagentDescendants(
        input({
          ancestorFilter: false,
          list: (params) =>
            Effect.sync(() => {
              parents.push(params.parentThreadId);
              return params.parentThreadId === "root"
                ? {
                    data: [
                      child("related"),
                      { ...child("old-unrelated", "different"), createdAt: 99 },
                    ],
                    nextCursor: "older",
                  }
                : { data: [], nextCursor: null };
            }),
        }),
      );
      assert.isTrue(result.complete);
      assert.deepEqual(parents, ["root", "related"]);
      assert.deepEqual(
        result.threads.map((t) => t.id),
        ["related"],
      );
    }),
  );

  it.effect(
    "scans repaired nonresident history to its end and keeps only the latest skeleton",
    () =>
      Effect.gen(function* () {
        const readIds: string[] = [];
        const topologyIds: string[] = [];
        const result = yield* discoverCodexSubagentDescendants(
          input({
            observedSpawnedThreadIds: (parent) =>
              parent === "root" ? ["repaired", "resident", "inline"] : [],
            isResident: (id) => id === "resident",
            read: (id) =>
              Effect.sync(() => {
                readIds.push(id);
                return {
                  ...child(id, id.startsWith("nested") ? "repaired" : "root"),
                  historyMode: id === "inline" ? "inline" : "paginated",
                } as Thread;
              }),
            turns: (id, cursor) =>
              Effect.sync(() => {
                topologyIds.push(id);
                if (id !== "repaired") return { data: [], nextCursor: null };
                const page = Number(cursor ?? 0);
                const turn =
                  page === 0
                    ? spawn("nested-first")
                    : page === 204
                      ? spawn("nested-last")
                      : turnFixture(`turn-${page}`);
                return { data: [turn], nextCursor: page === 204 ? null : `${page + 1}` };
              }),
          }),
        );
        assert.isTrue(result.complete);
        assert.deepEqual([...readIds].sort(), [
          "inline",
          "nested-first",
          "nested-last",
          "repaired",
          "resident",
        ]);
        assert.strictEqual(topologyIds.filter((id) => id === "repaired").length, 205);
        assert.notInclude(topologyIds, "root");
        assert.notInclude(topologyIds, "resident");
        assert.notInclude(topologyIds, "inline");
        const repaired = result.threads.find((t) => t.id === "repaired")!;
        assert.strictEqual(repaired.turns.length, 1);
        assert.strictEqual(repaired.turns[0]?.id, "spawn-nested-last");
        assert.strictEqual(repaired.turns[0]?.itemsView, "notLoaded");
        assert.deepEqual(repaired.turns[0]?.items, []);
      }),
  );

  it.effect("keeps metadata but marks a cyclic or failed child topology incomplete", () =>
    Effect.gen(function* () {
      for (const failure of ["cursor", "request"] as const) {
        const result = yield* discoverCodexSubagentDescendants(
          input({
            observedSpawnedThreadIds: (parent) => (parent === "root" ? ["repaired"] : []),
            read: (id) => Effect.succeed(child(id)),
            turns: () =>
              failure === "cursor"
                ? Effect.succeed({ data: [], nextCursor: "repeat" })
                : Effect.fail(
                    codexRuntimeError({ operation: "request", reason: "request", retryable: true }),
                  ),
          }),
        );
        assert.isFalse(result.complete);
        assert.deepEqual(
          result.threads.map((t) => t.id),
          ["repaired"],
        );
      }
    }),
  );

  it.effect("keeps durable-only hosts incomplete while repairing observed identities", () =>
    Effect.gen(function* () {
      const result = yield* discoverCodexSubagentDescendants(
        input({
          listSupported: false,
          list: () => Effect.die("Durable-only host must not list"),
          observedSpawnedThreadIds: (parent) => (parent === "root" ? ["child"] : []),
          isResident: () => true,
          read: (id) => Effect.succeed(child(id)),
        }),
      );
      assert.isFalse(result.complete);
      assert.deepEqual(
        result.threads.map((t) => t.id),
        ["child"],
      );
    }),
  );
});

describe("CodexConversationRelationshipsProjection", () => {
  const conversation = (
    threadId: string,
    overrides: Partial<CodexConversationSnapshot> = {},
  ): CodexConversationSnapshot => ({
    threadId,
    projectId: "project-1",
    source: null,
    threadName: "Thread",
    threadPreview: "Preview",
    cwd: "/tmp/project",
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
      canEditUserTurns: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
    ...overrides,
  });

  const durableChild = (
    threadId: string,
    overrides: Partial<CodexConversationRelationshipThread> = {},
  ): CodexConversationRelationshipThread => ({
    threadId,
    projectId: "project-1",
    parentThreadId: "parent",
    threadName: threadId,
    threadPreview: "",
    model: null,
    agentNickname: null,
    agentRole: null,
    agentPath: null,
    statusType: "idle",
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });

  describe("CodexConversationRelationshipsProjection", () => {
    test("projects canonical order, pending question role, friendly metadata, and archive filtering", () => {
      const childWithQuestion = conversation("child-b", {
        source: { parentThreadId: "parent" },
        threadName: "Scout",
        agentNickname: "@Scout",
        agentRole: "reviewer",
        agentPath: "agents/scout",
        turns: [
          {
            threadId: "child-b",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
        requests: [
          {
            type: "userInput",
            requestId: "approval-1",
            projectId: "project-1",
            threadId: "child-b",
            turnId: "turn-1",
            itemId: "item-1",
            isBlocking: true,
            questions: [],
            createdAt: 4,
          },
        ],
      });
      const memberships = projectCodexConversationRelationships({
        parent: conversationFixture("parent"),
        canonicalChildThreadIds: ["child-b"],
        children: [
          {
            thread: durableChild("child-a", { createdAt: 1 }),
            conversation: null,
            canonicalState: null,
          },
          {
            thread: durableChild("child-b", { createdAt: 2 }),
            conversation: childWithQuestion,
            canonicalState: null,
          },
          {
            thread: durableChild("child-archived", { archived: true }),
            conversation: null,
            canonicalState: null,
          },
        ],
      });

      expect(memberships.map(({ threadId }) => threadId)).toEqual(["child-b", "child-a"]);
      expect(memberships[0]).toMatchObject({
        role: "childApproval",
        actorName: "Scout",
        agentRole: "reviewer",
        agentPath: "agents/scout",
        showInlineActivity: true,
        thread: { nickname: "@Scout", agentRole: "reviewer" },
      });
      expect(memberships[1]).toMatchObject({
        role: "backgroundChild",
        actorName: "child-a",
        showInlineActivity: false,
      });
    });

    test("reads inline membership and questions from resident islands while durable archive state wins", () => {
      const parent = produce(
        conversationFixture("parent", [
          {
            ...turnFixture("parent-turn"),
            items: [
              {
                type: "subAgentActivity",
                model: null,
                reasoningEffort: null,
                id: "activity",
                kind: "started",
                agentThreadId: "child",
                agentPath: "/root/child",
              },
            ],
          },
        ]),
        (draft) => {
          replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
        },
      );
      const canonicalState = produce(
        {
          ...conversationFixture("child", [turnFixture("child-turn", "inProgress")]),
          title: "Current child",
          threadRuntimeStatus: { type: "active" as const, activeFlags: [] },
        },
        (draft) => {
          replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
        },
      );
      const stale = conversation("child", {
        archived: true,
        threadName: "Old title",
        requests: [
          {
            type: "userInput",
            requestId: "old",
            projectId: "project-1",
            threadId: "child",
            turnId: "child-turn",
            itemId: "command",
            isBlocking: true,
            questions: [],
            createdAt: 1,
          },
        ],
      });
      const project = (state: CodexCanonicalConversationState) =>
        projectCodexConversationRelationships({
          parent,
          canonicalChildThreadIds: extractCodexConversationRelationshipThreadIds(parent),
          children: [{ thread: durableChild("child"), canonicalState: state, conversation: stale }],
        });
      expect(project(canonicalState)[0]).toMatchObject({
        actorName: "Current child",
        statusType: "active",
        role: "backgroundChild",
        showInlineActivity: true,
      });
      expect(
        project({
          ...canonicalState,
          requests: [
            {
              id: 9,
              method: "item/tool/requestUserInput",
              params: {
                threadId: "child",
                turnId: "child-turn",
                itemId: "command",
                isBlocking: true,
                autoResolutionMs: null,
                questions: [],
              },
            },
          ],
        })[0]?.role,
      ).toBe("childApproval");
    });

    test.each(["legacy", "resident", "overlay"])(
      "keeps a child question visible from %s metadata without projecting item bodies",
      (storage) => {
        const initial: CodexCanonicalConversationState = {
          ...conversationFixture("child", [turnFixture("child-turn", "inProgress")]),
          requests: [
            {
              id: "child-question",
              method: "item/tool/requestUserInput",
              params: {
                threadId: "child",
                turnId: "child-turn",
                itemId: "question",
                isBlocking: true,
                autoResolutionMs: null,
                questions: [],
              },
            },
          ],
        };
        const canonicalState =
          storage === "legacy"
            ? initial
            : produce(initial, (draft) => {
                const turns = draft.turns;
                replaceCanonicalHistoryDraft(draft, storage === "overlay" ? [] : turns, true, null);
                if (storage === "overlay") draft.turns = turns;
              });
        const projected = projectCodexConversationRelationships({
          parent: conversationFixture("parent"),
          canonicalChildThreadIds: ["child"],
          children: [{ thread: durableChild("child"), canonicalState, conversation: null }],
        });
        expect(projected[0]?.role).toBe("childApproval");
        expect(projected[0]?.pendingRequest?.request.requestId).toBe("child-question");
        expect(projected[0]?.pendingRequest?.requestItem).toBeNull();
      },
    );
  });
});
