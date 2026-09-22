import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import type {
  CodexConversationChildMembership,
  CodexConversationSnapshot,
} from "../../shared/types";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import {
  extractCodexConversationRelationshipThreadIds,
  hasFriendlyCodexConversationRelationshipIdentity,
  projectCodexConversationRelationships,
  type CodexConversationRelationshipChild,
  type CodexConversationRelationshipThread,
} from "./CodexConversationRelationshipsProjection";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import type { ConversationEntityState } from "./internal/ConversationEntityState";

const REPAIR_RETRY = "30 seconds";
const PAGE_SIZE = 200;

/**
 * Relationship projection is metadata fan-out, never Subagent discovery or transcript transport.
 * Its independent envelope is intentionally wider than the bounded Subagent overview: this
 * projection preserves immediate parent identities and forwards resident descendants' pending
 * requests. `CodexSubagentDirectory` owns discovery and the complete Agent overview.
 */
export const CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_PAGES = 32;
export const CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_RESULTS = 6_400;
export const CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_RESULT_BYTES = 32 * 1024 * 1024;
export const CODEX_CONVERSATION_RELATIONSHIP_CHILD_PAGE_TIMEOUT_MS = 10_000;
export const CODEX_CONVERSATION_RELATIONSHIP_CHILD_SCAN_DEADLINE_MS = 30_000;
export const CODEX_CONVERSATION_RELATIONSHIP_MAX_ACTIVE_REPAIRS = 32;
export const CODEX_CONVERSATION_RELATIONSHIP_MAX_REMOVED_TOMBSTONES =
  CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_RESULTS;

type CoreChildThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "child_thread_window" }
>["threads"]["items"][number];

export class CodexConversationRelationshipsError extends Schema.TaggedError<CodexConversationRelationshipsError>()(
  "CodexConversationRelationshipsError",
  {
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexConversationRelationships extends Context.Service<
  CodexConversationRelationships,
  {
    /** Rebuilds and broadcasts one parent's derived relationship projection. */
    readonly refresh: (
      parentThreadId: string,
    ) => Effect.Effect<
      readonly CodexConversationChildMembership[],
      CodexConversationRelationshipsError
    >;
  }
>()("nodex/main/codex-application/CodexConversationRelationships") {}

const projectCoreChild = (thread: CoreChildThread): CodexConversationRelationshipThread => ({
  threadId: thread.thread_id,
  projectId: thread.project_id ?? null,
  parentThreadId: thread.parent_thread_id ?? null,
  threadName: thread.thread_name ?? null,
  threadPreview: thread.thread_preview,
  model: thread.model_id ?? null,
  agentNickname: thread.agent_nickname ?? null,
  agentRole: thread.agent_role ?? null,
  agentPath: thread.agent_path ?? null,
  statusType: thread.status.status_type,
  archived: thread.archived,
  createdAt: thread.created_at,
  updatedAt: thread.updated_at,
});

const projectSnapshotChild = (
  parentThreadId: string,
  conversation: CodexConversationSnapshot,
): CodexConversationRelationshipThread => ({
  threadId: conversation.threadId,
  projectId: conversation.projectId,
  parentThreadId: conversation.source?.parentThreadId ?? parentThreadId,
  threadName: conversation.threadName,
  threadPreview: conversation.threadPreview,
  model: conversation.executionProfile?.modelId ?? null,
  agentNickname: conversation.agentNickname ?? null,
  agentRole: conversation.agentRole ?? null,
  agentPath: conversation.agentPath ?? null,
  statusType: conversation.statusType,
  archived: conversation.archived,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
});

const provisionalChild = (
  parentThreadId: string,
  childThreadId: string,
  projectId: string | null,
): CodexConversationRelationshipThread => ({
  threadId: childThreadId,
  projectId,
  parentThreadId,
  threadName: null,
  threadPreview: "",
  model: null,
  agentNickname: null,
  agentRole: null,
  agentPath: null,
  statusType: "notLoaded",
  archived: false,
  createdAt: 0,
  updatedAt: 0,
});

export const make: Effect.Effect<
  CodexConversationRelationships["Service"],
  never,
  | CodexApplicationEventHub
  | CodexThreadDirectory
  | ConversationEntityMap
  | CoreModules
  | Scope.Scope
> = Effect.gen(function* () {
  const events = yield* CodexApplicationEventHub;
  const directory = yield* CodexThreadDirectory;
  const conversations = yield* ConversationEntityMap;
  const core = yield* CoreModules;
  const repairs = yield* FiberMap.make<string, void>();
  const runRepair = yield* FiberMap.runtime(repairs)();
  const repairKeysByChild = new Map<string, Set<string>>();
  const refreshes = yield* FiberMap.make<string, void>();
  const runRefresh = yield* FiberMap.runtime(refreshes)();
  const descendantsByParent = new Map<string, ReadonlySet<string>>();
  const removedThreadIds = new Set<string>();
  let removedThreadIdsSaturated = false;
  let activeRepairCount = 0;

  const error = (threadId: string, cause: unknown): CodexConversationRelationshipsError =>
    new CodexConversationRelationshipsError({ threadId, cause });

  const readChildren = Effect.fn("CodexConversationRelationships.readChildren")(function* (
    parentThreadId: string,
  ): Effect.fn.Return<readonly CoreChildThread[], CodexConversationRelationshipsError> {
    const children: CoreChildThread[] = [];
    const seenChildThreadIds = new Set<string>();
    const seenCursors = new Set<string | null>();
    let after: string | null = null;
    let resultBytes = 0;
    const startedAtMs = yield* Clock.currentTimeMillis;

    for (let page = 0; page < CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_PAGES; page += 1) {
      const remainingDeadlineMs =
        CODEX_CONVERSATION_RELATIONSHIP_CHILD_SCAN_DEADLINE_MS -
        ((yield* Clock.currentTimeMillis) - startedAtMs);
      if (remainingDeadlineMs <= 0) {
        return yield* error(
          parentThreadId,
          new Error("Child Thread relationship scan exceeded its total deadline"),
        );
      }
      if (seenCursors.has(after)) {
        return yield* error(
          parentThreadId,
          new Error("Child Thread relationship cursor did not advance"),
        );
      }
      seenCursors.add(after);
      const response = yield* core.workspace
        .read({
          kind: "child_thread_window",
          parent_thread_id: parentThreadId,
          include_archived: false,
          window: { after, first: PAGE_SIZE },
        })
        .pipe(
          Effect.timeoutOption(
            Math.min(CODEX_CONVERSATION_RELATIONSHIP_CHILD_PAGE_TIMEOUT_MS, remainingDeadlineMs),
          ),
          Effect.mapError((cause) => error(parentThreadId, cause)),
        );
      if (Option.isNone(response)) {
        return yield* error(
          parentThreadId,
          new Error("Child Thread relationship page exceeded its deadline"),
        );
      }
      const snapshot: ProjectWorkspaceReadSnapshot = response.value;
      if (snapshot.value.kind !== "child_thread_window") {
        return yield* error(
          parentThreadId,
          new Error("Core returned the wrong child Thread read variant"),
        );
      }
      const pageItems = snapshot.value.threads.items;
      if (pageItems.length > PAGE_SIZE) {
        return yield* error(
          parentThreadId,
          new Error(`Child Thread relationship page exceeded its ${PAGE_SIZE}-result limit`),
        );
      }
      if (
        cappedApproximateValueBytes(
          pageItems,
          CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_PAGE_BYTES,
        ) > CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_PAGE_BYTES
      ) {
        return yield* error(
          parentThreadId,
          new Error("Child Thread relationship page is too large"),
        );
      }
      for (const child of pageItems) {
        if (seenChildThreadIds.has(child.thread_id)) continue;
        if (children.length >= CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_RESULTS) {
          return yield* error(
            parentThreadId,
            new Error("Child Thread relationship scan exceeded its result budget"),
          );
        }
        const remainingBytes = CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_RESULT_BYTES - resultBytes;
        const childBytes = cappedApproximateValueBytes(child, remainingBytes);
        if (childBytes > remainingBytes) {
          return yield* error(
            parentThreadId,
            new Error("Child Thread relationship scan exceeded its byte budget"),
          );
        }
        children.push(child);
        seenChildThreadIds.add(child.thread_id);
        resultBytes += childBytes;
      }
      const nextCursor = snapshot.value.threads.next_cursor ?? null;
      if (nextCursor === null) return children;
      if (seenCursors.has(nextCursor)) {
        return yield* error(
          parentThreadId,
          new Error("Child Thread relationship response repeated its continuation cursor"),
        );
      }
      if (page + 1 >= CODEX_CONVERSATION_RELATIONSHIP_CHILD_MAX_PAGES) {
        return yield* error(
          parentThreadId,
          new Error("Child Thread relationship scan exceeded its page budget"),
        );
      }
      after = nextCursor;
    }
    return yield* error(
      parentThreadId,
      new Error("Child Thread relationship scan exhausted its page budget"),
    );
  });

  const includeInvalidatedAncestors = Effect.fn(
    "CodexConversationRelationships.includeInvalidatedAncestors",
  )(function* (threadIds: readonly string[]) {
    const ancestors = new Set(threadIds.map((id) => id.trim()).filter(Boolean));
    const pending = [...ancestors];
    for (let index = 0; index < pending.length; index += 1) {
      const threadId = pending[index]!;
      const resident = conversations.current(threadId)?.readCanonicalState();
      let parentId = resident?.parentThreadId ?? null;
      if (!resident) {
        const record = yield* core.workspace
          .read({ kind: "thread", thread_id: threadId })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not resolve pending-request ancestry").pipe(
                Effect.annotateLogs({ threadId, cause }),
                Effect.as(null),
              ),
            ),
          );
        if (record?.value.kind === "thread")
          parentId = record.value.thread?.parent_thread_id ?? null;
      }
      if (!parentId || ancestors.has(parentId)) continue;
      ancestors.add(parentId);
      pending.push(parentId);
    }
    return ancestors;
  });

  const publish = (
    hostId: string,
    parentThreadId: string,
    memberships: readonly CodexConversationChildMembership[],
  ): void => {
    events.publish({
      kind: "hostMessage",
      value: {
        type: "sharedObjectUpdated",
        hostId,
        object: {
          objectType: "conversationChildMemberships",
          objectId: parentThreadId,
          value: { parentThreadId, childMemberships: [...memberships] },
        },
      },
    });
  };

  let refreshPhysical: (
    parentThreadId: string,
  ) => Effect.Effect<
    readonly CodexConversationChildMembership[],
    CodexConversationRelationshipsError
  >;

  const repairOnce = Effect.fn("CodexConversationRelationships.repairOnce")(function* (
    parentThreadId: string,
    childThreadId: string,
    hostId: string,
  ): Effect.fn.Return<boolean> {
    const entry = yield* directory
      .resolve({
        threadId: childThreadId,
        fidelity: "metadata",
        hostId,
        metadataScheduling: {
          conversationId: parentThreadId,
          widgetId: `conversation-relationships:${childThreadId}`,
        },
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not refresh Codex child Thread metadata").pipe(
            Effect.annotateLogs({ parentThreadId, childThreadId, cause }),
            Effect.as(null),
          ),
        ),
      );
    if (!entry) return false;
    const actualParentThreadId = entry.durable.parentThreadId;
    if (actualParentThreadId) {
      yield* refreshPhysical(actualParentThreadId).pipe(Effect.ignore);
    }
    if (actualParentThreadId !== parentThreadId) return true;
    return hasFriendlyCodexConversationRelationshipIdentity({
      threadId: entry.durable.threadId,
      projectId: entry.durable.projectId,
      parentThreadId: entry.durable.parentThreadId,
      threadName: entry.durable.threadName,
      threadPreview: entry.durable.threadPreview,
      model: entry.durable.executionProfile?.modelId ?? null,
      agentNickname: entry.durable.agentNickname,
      agentRole: entry.durable.agentRole,
      agentPath: entry.durable.agentPath,
      statusType: entry.durable.statusType,
      archived: entry.durable.archived,
      createdAt: entry.durable.createdAt,
      updatedAt: entry.durable.updatedAt,
    });
  });

  const repairLoop = (
    parentThreadId: string,
    childThreadId: string,
    hostId: string,
  ): Effect.Effect<void> =>
    repairOnce(parentThreadId, childThreadId, hostId).pipe(
      Effect.flatMap((complete) =>
        complete
          ? Effect.void
          : Effect.sleep(REPAIR_RETRY).pipe(
              Effect.andThen(
                Effect.suspend(() => repairLoop(parentThreadId, childThreadId, hostId)),
              ),
            ),
      ),
    );

  const repairInParentLifetime = Effect.fn("CodexConversationRelationships.repairInParentLifetime")(
    function* (parent: ConversationEntityState, childThreadId: string, hostId: string) {
      if (conversations.current(parent.threadId) !== parent) return;
      let subscription: Disposable | undefined;
      const retired = Effect.callback<void>((resume) => {
        subscription = conversations.subscribeRetired((threadId, generation) => {
          if (threadId === parent.threadId && generation === parent.generation) resume(Effect.void);
        });
        if (conversations.current(parent.threadId) !== parent) resume(Effect.void);
      }).pipe(Effect.ensuring(Effect.sync(() => subscription?.[Symbol.dispose]())));
      yield* Effect.raceFirst(retired, repairLoop(parent.threadId, childThreadId, hostId));
    },
  );

  refreshPhysical = Effect.fn("CodexConversationRelationships.refresh")(function* (
    rawParentThreadId: string,
  ): Effect.fn.Return<
    readonly CodexConversationChildMembership[],
    CodexConversationRelationshipsError
  > {
    const parentThreadId = rawParentThreadId.trim();
    if (!parentThreadId || !conversations.current(parentThreadId)) return [];
    return yield* conversations.runCommand(
      parentThreadId,
      Effect.gen(function* () {
        const parentAggregate = conversations.current(parentThreadId);
        if (!parentAggregate) return [];
        if (!parentAggregate.readCanonicalState()) return [];
        const parentRecord = yield* core.workspace
          .read({ kind: "thread", thread_id: parentThreadId })
          .pipe(Effect.mapError((cause) => error(parentThreadId, cause)));
        if (parentRecord.value.kind !== "thread") return [];
        if (conversations.current(parentThreadId) !== parentAggregate) return [];
        const durableChildren = yield* readChildren(parentThreadId);
        if (conversations.current(parentThreadId) !== parentAggregate) return [];
        const parent = parentAggregate.readCanonicalState();
        if (!parent) return [];
        const canonicalChildThreadIds = extractCodexConversationRelationshipThreadIds(parent);
        const childrenById = new Map<string, CodexConversationRelationshipThread>(
          durableChildren.map((child) => [child.thread_id, projectCoreChild(child)]),
        );
        const childThreadIds = new Set([
          ...canonicalChildThreadIds,
          ...durableChildren.map((child) => child.thread_id),
        ]);
        const durableChildIds = new Set(childrenById.keys());
        // Canonical pending requests already live in Main. Resolve ancestry from metadata only;
        // opening a child transcript must never be a prerequisite for its parent's approval UI.
        const resident = conversations.forHost(parentRecord.value.thread.execution_host_id);
        const ancestry = new Map<string, CodexConversationRelationshipThread>(childrenById);
        for (const entity of resident) {
          const state = entity.readCanonicalState();
          if (!state || ancestry.has(entity.threadId)) continue;
          const snapshot = entity.readSnapshot();
          ancestry.set(
            entity.threadId,
            snapshot
              ? projectSnapshotChild(state.parentThreadId ?? "", snapshot)
              : provisionalChild(
                  state.parentThreadId ?? "",
                  entity.threadId,
                  parentRecord.value.thread.project_id ?? null,
                ),
          );
        }
        for (const entity of resident) {
          if (entity.threadId === parentThreadId || childThreadIds.has(entity.threadId)) continue;
          const path: CodexConversationRelationshipThread[] = [];
          const visited = new Set<string>();
          let ancestorId: string | null = entity.threadId;
          while (ancestorId && ancestorId !== parentThreadId && !visited.has(ancestorId)) {
            visited.add(ancestorId);
            let ancestor = ancestry.get(ancestorId);
            if (!ancestor) {
              const record = yield* core.workspace
                .read({ kind: "thread", thread_id: ancestorId })
                .pipe(Effect.mapError((cause) => error(parentThreadId, cause)));
              if (
                record.value.kind !== "thread" ||
                !record.value.thread ||
                record.value.thread.execution_host_id !==
                  parentRecord.value.thread.execution_host_id
              )
                break;
              ancestor = projectCoreChild(record.value.thread);
              ancestry.set(ancestorId, ancestor);
              durableChildIds.add(ancestorId);
            }
            if (ancestor.archived) break;
            path.push(ancestor);
            ancestorId = ancestor.parentThreadId;
          }
          if (ancestorId !== parentThreadId) continue;
          for (const descendant of path.reverse()) {
            childThreadIds.add(descendant.threadId);
            childrenById.set(descendant.threadId, descendant);
          }
        }
        if (conversations.current(parentThreadId) !== parentAggregate) return [];
        const children: CodexConversationRelationshipChild[] = [];
        for (const childThreadId of childThreadIds) {
          // Once deletion pressure exceeds the tombstone envelope, trust only Core's bounded
          // durable child window. This fails closed instead of resurrecting a deleted canonical id.
          if (removedThreadIdsSaturated && !durableChildIds.has(childThreadId)) continue;
          if (removedThreadIds.has(childThreadId)) continue;
          const childEntity = conversations.current(childThreadId);
          const childConversation = childEntity?.readSnapshot() ?? null;
          const canonicalState = childEntity?.readCanonicalState() ?? null;
          const thread =
            childrenById.get(childThreadId) ??
            (childConversation
              ? projectSnapshotChild(parentThreadId, childConversation)
              : provisionalChild(
                  canonicalState?.parentThreadId ?? parentThreadId,
                  childThreadId,
                  parentRecord.value.thread.project_id ?? null,
                ));
          const child = { thread, conversation: childConversation, canonicalState };
          children.push(child);
          // A live display name does not prove that the durable child metadata was repaired.
          if (!hasFriendlyCodexConversationRelationshipIdentity(thread)) {
            const key = JSON.stringify([parentThreadId, childThreadId]);
            if (FiberMap.hasUnsafe(repairs, key)) continue;
            if (activeRepairCount >= CODEX_CONVERSATION_RELATIONSHIP_MAX_ACTIVE_REPAIRS) continue;
            activeRepairCount += 1;
            let keys = repairKeysByChild.get(childThreadId);
            if (!keys) {
              keys = new Set();
              repairKeysByChild.set(childThreadId, keys);
            }
            keys.add(key);
            runRepair(
              key,
              repairInParentLifetime(
                parentAggregate,
                childThreadId,
                parentRecord.value.thread.execution_host_id,
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    activeRepairCount -= 1;
                    const current = repairKeysByChild.get(childThreadId);
                    current?.delete(key);
                    if (current?.size === 0) repairKeysByChild.delete(childThreadId);
                  }),
                ),
              ),
            );
          }
        }

        const memberships = projectCodexConversationRelationships({
          parent,
          canonicalChildThreadIds,
          children,
        });
        descendantsByParent.set(
          parentThreadId,
          new Set(memberships.map((membership) => membership.threadId)),
        );
        publish(parentRecord.value.thread.execution_host_id, parentThreadId, memberships);
        return memberships;
      }),
    );
  });

  const mutationSubscription = conversations.subscribeCanonicalMutations((mutation) => {
    const { before, after } = mutation;
    if (!before?.requests.length && !after?.requests.length) return;
    events.publish({
      kind: "conversationRelationshipsInvalidated",
      value: {
        parentThreadIds: [
          ...new Set(
            [mutation.threadId, before?.parentThreadId, after?.parentThreadId].filter(
              (id): id is string => Boolean(id),
            ),
          ),
        ],
      },
    });
  });
  const retirementSubscription = conversations.subscribeRetired((threadId) =>
    descendantsByParent.delete(threadId),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      mutationSubscription[Symbol.dispose]();
      retirementSubscription[Symbol.dispose]();
    }),
  );

  yield* events.events.pipe(
    Stream.runForEach((event) => {
      if (event.kind !== "conversationRelationshipsInvalidated") return Effect.void;
      return Effect.gen(function* () {
        let saturatedNow = false;
        for (const threadId of event.value.removedThreadIds ?? []) {
          const normalized = threadId.trim();
          if (!normalized) continue;
          if (!removedThreadIdsSaturated) {
            if (
              !removedThreadIds.has(normalized) &&
              removedThreadIds.size >= CODEX_CONVERSATION_RELATIONSHIP_MAX_REMOVED_TOMBSTONES
            ) {
              removedThreadIdsSaturated = true;
              removedThreadIds.clear();
              saturatedNow = true;
            } else {
              removedThreadIds.add(normalized);
            }
          }
          for (const key of repairKeysByChild.get(normalized) ?? []) {
            yield* FiberMap.remove(repairs, key);
          }
          repairKeysByChild.delete(normalized);
        }
        for (const threadId of event.value.restoredThreadIds ?? []) {
          removedThreadIds.delete(threadId.trim());
        }
        if (saturatedNow) {
          yield* Effect.logWarning(
            "Codex relationship deletion pressure exceeded its tombstone budget; canonical-only children are suppressed until restart",
          );
        }
        const affectedParents = yield* includeInvalidatedAncestors(event.value.parentThreadIds);
        for (const [parentId, descendants] of descendantsByParent) {
          if (event.value.parentThreadIds.some((id) => descendants.has(id)))
            affectedParents.add(parentId);
        }
        for (const rawParentThreadId of affectedParents) {
          const parentThreadId = rawParentThreadId.trim();
          if (!parentThreadId) continue;
          runRefresh(
            parentThreadId,
            refreshPhysical(parentThreadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not refresh Codex conversation relationships").pipe(
                  Effect.annotateLogs({ parentThreadId, cause }),
                ),
              ),
              Effect.asVoid,
            ),
          );
        }
      });
    }),
    Effect.forkScoped,
  );

  return CodexConversationRelationships.of({ refresh: refreshPhysical });
});
