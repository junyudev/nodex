import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { ProjectWorkspaceIntent, ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError, CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";

export const CODEX_PINNED_THREAD_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

type CoreSection = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "sidebar_section_window" }
>["sections"]["items"][number];
type CoreHostLink = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "sidebar_section_host_link_window" }
>["links"]["items"][number];
type RemoteSection = ClientRequestResponsesByMethod["threadSection/list"]["data"][number];
type RemoteThread = ClientRequestResponsesByMethod["thread/list"]["data"][number];

type SyncReason =
  | "startup"
  | "periodic"
  | "connection-ready"
  | "local-mutation"
  | "agent-mutation"
  | "manual";

export interface CodexSidebarSectionHostSyncResult {
  readonly hostId: string;
  readonly generation: number;
  readonly capability: "supported" | "unsupported";
  readonly importedSections: number;
  readonly projectedThreads: number;
}

export class CodexSidebarSectionSyncError extends Data.TaggedError("CodexSidebarSectionSyncError")<{
  readonly operation: string;
  readonly hostId: string | null;
  readonly retryable: boolean;
  readonly cause: unknown;
}> {}

export class CodexSidebarSectionSync extends Context.Service<
  CodexSidebarSectionSync,
  {
    /** Enqueues a coalescible reconciliation signal; local commands never await remote RPCs. */
    readonly request: (reason: SyncReason) => Effect.Effect<void>;
    readonly syncHost: (
      hostId: string,
      reason?: SyncReason,
    ) => Effect.Effect<CodexSidebarSectionHostSyncResult, CodexSidebarSectionSyncError>;
    readonly syncAll: (
      reason?: SyncReason,
    ) => Effect.Effect<readonly CodexSidebarSectionHostSyncResult[]>;
  }
>()("nodex/main/codex-application/CodexSidebarSectionSync") {}

const syncError = (
  operation: string,
  hostId: string | null,
  cause: unknown,
): CodexSidebarSectionSyncError =>
  cause instanceof CodexSidebarSectionSyncError
    ? cause
    : new CodexSidebarSectionSyncError({
        operation,
        hostId,
        retryable: cause instanceof CodexRuntimeError ? cause.retryable : true,
        cause,
      });

const isUnsupportedSectionCapability = (cause: unknown): boolean =>
  cause instanceof CodexRuntimeError &&
  cause.method === "threadSection/list" &&
  cause.reason === "request" &&
  !cause.retryable;

const normalizedRemoteName = (name: string): string => {
  const normalized = name.trim().slice(0, 120);
  return normalized || "Imported section";
};

const hostLink = (input: {
  readonly sectionId: string;
  readonly hostId: string;
  readonly remoteSectionId: string | null;
  readonly syncState: CoreHostLink["sync_state"];
  readonly generation: number;
  readonly lastError?: string | null;
}): CoreHostLink => ({
  section_id: input.sectionId,
  host_id: input.hostId,
  remote_section_id: input.remoteSectionId,
  sync_state: input.syncState,
  observed_generation: input.generation,
  last_error: input.lastError ?? null,
  updated_at: new Date().toISOString(),
});

const retrySchedule = Schedule.max([Schedule.exponential("250 millis"), Schedule.recurs(3)]).pipe(
  Schedule.jittered,
);

interface HostedTask {
  readonly threadId: string;
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly pinned: boolean;
}

interface LocalProjection {
  readonly tasks: readonly HostedTask[];
  readonly desiredLogicalSectionByThread: ReadonlyMap<string, string | "pinned" | null>;
  readonly orderedThreadsByLogicalSection: ReadonlyMap<string | "pinned", readonly string[]>;
  readonly directSectionBySession: ReadonlyMap<string, string>;
  readonly projectSectionByProject: ReadonlyMap<string, string>;
}

interface RemoteMembership {
  readonly sectionByThread: ReadonlyMap<string, string | null>;
  readonly orderedThreadsBySection: ReadonlyMap<string, readonly string[]>;
}

type RemoteThreadListScope =
  | { readonly kind: "section"; readonly sectionId: string }
  | { readonly kind: "unsectioned" };

const remoteThreadListParams = (
  scope: RemoteThreadListScope,
  cursor: string | null,
): ClientRequestParamsByMethod["thread/list"] => ({
  cursor,
  limit: 100,
  modelProviders: null,
  sourceKinds: [],
  archived: false,
  useStateDbOnly: true,
  ...(scope.kind === "section"
    ? {
        sectionId: scope.sectionId,
        sortKey: "section_position",
        sortDirection: "asc",
      }
    : {
        sectionId: null,
        // Unsectioned Threads have no section position. Creation time is immutable, so ascending
        // keyset pagination remains stable while a reconciliation pass is in flight.
        sortKey: "created_at",
        sortDirection: "asc",
      }),
});

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const syncFailureIdentity = (error: CodexSidebarSectionSyncError): string => {
  const cause = error.cause;
  if (!(cause instanceof CodexRuntimeError)) {
    return [error.operation, error.retryable, errorMessage(cause)].join("\0");
  }
  return [
    error.operation,
    error.retryable,
    cause.operation,
    cause.reason,
    cause.method ?? "",
    cause.generation ?? "",
    errorMessage(cause.cause),
  ].join("\0");
};

/**
 * Reconciles Core logical Sections with app-server's Thread-only projection. Core remains usable
 * offline; host links are the durable outbox/capability ledger and are fenced by host generation.
 */
export const make: Effect.Effect<
  CodexSidebarSectionSync["Service"],
  never,
  | CodexGateway
  | CodexThreadCatalog
  | CodexThreadDirectory
  | CoreModules
  | ExecutionHostRuntime
  | Scope.Scope
> = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const catalog = yield* CodexThreadCatalog;
  const directory = yield* CodexThreadDirectory;
  const core = yield* CoreModules;
  const executionHosts = yield* ExecutionHostRuntime;
  const signals = yield* Queue.sliding<SyncReason>(32);
  const lanes = yield* RcMap.make({ lookup: (_hostId: string) => Semaphore.make(1) });
  const unsupportedGenerations = new Map<string, number>();
  // Reconciliation must keep polling for recovery, but one unchanged failure episode should not
  // emit a warning every 30 seconds. Success or a changed failure identity opens a new episode.
  const activeFailureEpisodes = new Map<string, string>();
  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.asVoid));

  const apply = Effect.fn("CodexSidebarSectionSync.apply")(function* (
    intent: ProjectWorkspaceIntent,
  ) {
    return yield* core.workspace.apply({
      operationId: createOperationId("sidebar-section.sync"),
      intent,
    });
  });

  const readSections = Effect.fn("CodexSidebarSectionSync.readSections")(function* () {
    const snapshot = yield* core.workspace.read({
      kind: "sidebar_section_window",
      include_deleted: true,
      window: { after: null, first: 200 },
    });
    if (snapshot.value.kind !== "sidebar_section_window") {
      return yield* Effect.die(new Error("Core returned a non-Section window"));
    }
    if (snapshot.value.sections.next_cursor) {
      return yield* Effect.die(new Error("Sidebar Section collection exceeds sync bound"));
    }
    return snapshot.value.sections.items.filter((section) => section.kind === "custom");
  });

  const readItems = Effect.fn("CodexSidebarSectionSync.readItems")(function* (sectionId: string) {
    const snapshot = yield* core.workspace.read({
      kind: "sidebar_section_item_window",
      section_id: sectionId,
      include_archived: false,
      window: { after: null, first: 200 },
    });
    if (snapshot.value.kind !== "sidebar_section_item_window") {
      return yield* Effect.die(new Error("Core returned a non-Section item window"));
    }
    if (snapshot.value.items.next_cursor) {
      return yield* Effect.die(new Error(`Section '${sectionId}' exceeds sync item bound`));
    }
    return snapshot.value.items.items;
  });

  const readLinks = Effect.fn("CodexSidebarSectionSync.readLinks")(function* (hostId: string) {
    const snapshot = yield* core.workspace.read({
      kind: "sidebar_section_host_link_window",
      host_id: hostId,
      window: { after: null, first: 200 },
    });
    if (snapshot.value.kind !== "sidebar_section_host_link_window") {
      return yield* Effect.die(new Error("Core returned a non-Section host-link window"));
    }
    if (snapshot.value.links.next_cursor) {
      return yield* Effect.die(new Error(`Host '${hostId}' Section links exceed sync bound`));
    }
    return snapshot.value.links.items;
  });

  const upsertLink = Effect.fn("CodexSidebarSectionSync.upsertLink")(function* (
    link: CoreHostLink,
  ) {
    yield* apply({ kind: "upsert_sidebar_section_host_link", link });
  });

  const deleteLink = Effect.fn("CodexSidebarSectionSync.deleteLink")(function* (
    sectionId: string,
    hostId: string,
  ) {
    yield* apply({
      kind: "delete_sidebar_section_host_link",
      section_id: sectionId,
      host_id: hostId,
    });
  });

  const readyGeneration = Effect.fn("CodexSidebarSectionSync.readyGeneration")(function* (
    hostId: string,
  ) {
    const connection = yield* gateway.connection(hostId);
    if (connection.kind === "ready") return connection.generation;
    return yield* codexRuntimeError({
      operation: "sidebar-section.connection",
      reason: "host-unavailable",
      retryable: true,
      hostId,
      cause: new Error(`Host is ${connection.kind}`),
    });
  });

  const assertGeneration = Effect.fn("CodexSidebarSectionSync.assertGeneration")(function* (
    hostId: string,
    generation: number,
  ) {
    const current = yield* gateway.connection(hostId);
    if (current.kind === "ready" && current.generation === generation) return;
    return yield* codexRuntimeError({
      operation: "sidebar-section.generation-fence",
      reason: "session-lost",
      retryable: true,
      hostId,
      generation,
    });
  });

  const listRemoteSections = Effect.fn("CodexSidebarSectionSync.listRemoteSections")(function* (
    hostId: string,
  ) {
    const pages = (
      cursor: string | null,
      collected: readonly RemoteSection[],
      page: number,
    ): Effect.Effect<readonly RemoteSection[], CodexRuntimeError> =>
      gateway.requestOnHost(hostId, "threadSection/list", { cursor, limit: 100 }).pipe(
        Effect.flatMap((response) => {
          const next = [...collected, ...response.data];
          if (!response.nextCursor) return Effect.succeed(next);
          if (page >= 20) {
            return Effect.fail(
              codexRuntimeError({
                operation: "sidebar-section.list-bound",
                reason: "protocol",
                retryable: false,
                hostId,
              }),
            );
          }
          return pages(response.nextCursor, next, page + 1);
        }),
      );
    return yield* pages(null, [], 1);
  });

  const listRemoteThreads = Effect.fn("CodexSidebarSectionSync.listRemoteThreads")(function* (
    hostId: string,
    scope: RemoteThreadListScope,
  ) {
    const pages = (
      cursor: string | null,
      collected: readonly RemoteThread[],
      page: number,
    ): Effect.Effect<readonly RemoteThread[], CodexRuntimeError> =>
      gateway.requestOnHost(hostId, "thread/list", remoteThreadListParams(scope, cursor)).pipe(
        Effect.flatMap((response) => {
          const next = [...collected, ...response.data];
          if (!response.nextCursor) return Effect.succeed(next);
          if (page >= 20) {
            return Effect.fail(
              codexRuntimeError({
                operation: "sidebar-section.thread-list-bound",
                reason: "protocol",
                retryable: false,
                hostId,
              }),
            );
          }
          return pages(response.nextCursor, next, page + 1);
        }),
      );
    return yield* pages(null, [], 1);
  });

  const readLocalProjection = Effect.fn("CodexSidebarSectionSync.readLocalProjection")(function* (
    hostId: string,
    sections: readonly CoreSection[],
  ) {
    const activeSections = sections.filter((section) => section.lifecycle === "active");
    const itemsBySection = new Map(
      yield* Effect.forEach(activeSections, (section) =>
        readItems(section.section_id).pipe(
          Effect.map((items) => [section.section_id, items] as const),
        ),
      ),
    );
    const directSectionBySession = new Map<string, string>();
    const projectSectionByProject = new Map<string, string>();
    for (const [sectionId, items] of itemsBySection) {
      for (const item of items) {
        if (item.value.kind === "session") {
          directSectionBySession.set(item.value.session.session_id, sectionId);
        } else {
          projectSectionByProject.set(item.value.project.project_id, sectionId);
        }
      }
    }
    const palette = yield* catalog.listPalette({ scope: "sidebar" });
    const tasks = (yield* Effect.forEach(
      palette.filter((task) => task.sessionId !== null),
      (task) =>
        directory.resolve({ threadId: task.threadId, fidelity: "durable" }).pipe(
          Effect.map((entry): HostedTask | null =>
            entry?.durable.executionHostId === hostId && task.sessionId
              ? {
                  threadId: task.threadId,
                  sessionId: task.sessionId,
                  projectId: task.projectId,
                  pinned: task.pinned,
                }
              : null,
          ),
        ),
      { concurrency: 8 },
    )).filter((task): task is HostedTask => task !== null);
    const projectSnapshot = yield* core.workspace.read({
      kind: "project_window",
      include_archived: false,
      window: { after: null, first: 200 },
    });
    if (projectSnapshot.value.kind !== "project_window") {
      return yield* Effect.die(new Error("Core returned a non-Project window"));
    }
    const pinnedProjects = new Set(
      projectSnapshot.value.projects.items
        .filter((project) => project.pinned)
        .map((project) => project.id),
    );
    const desiredLogicalSectionByThread = new Map<string, string | "pinned" | null>();
    for (const task of tasks) {
      desiredLogicalSectionByThread.set(
        task.threadId,
        task.pinned
          ? "pinned"
          : (directSectionBySession.get(task.sessionId) ??
              (task.projectId ? projectSectionByProject.get(task.projectId) : undefined) ??
              (task.projectId && pinnedProjects.has(task.projectId) ? "pinned" : null)),
      );
    }
    const orderedThreadsByLogicalSection = new Map<string | "pinned", readonly string[]>();
    for (const [sectionId, items] of itemsBySection) {
      const ordered: string[] = [];
      for (const item of items) {
        if (item.value.kind === "session") {
          const sessionId = item.value.session.session_id;
          const task = tasks.find((candidate) => candidate.sessionId === sessionId);
          if (task && !ordered.includes(task.threadId)) ordered.push(task.threadId);
          continue;
        }
        for (const task of tasks) {
          if (
            task.projectId === item.value.project.project_id &&
            !task.pinned &&
            !directSectionBySession.has(task.sessionId) &&
            !ordered.includes(task.threadId)
          ) {
            ordered.push(task.threadId);
          }
        }
      }
      orderedThreadsByLogicalSection.set(sectionId, ordered);
    }
    orderedThreadsByLogicalSection.set(
      "pinned",
      tasks
        .filter(
          (task) => task.pinned || (task.projectId !== null && pinnedProjects.has(task.projectId)),
        )
        .map((task) => task.threadId),
    );
    return {
      tasks,
      desiredLogicalSectionByThread,
      orderedThreadsByLogicalSection,
      directSectionBySession,
      projectSectionByProject,
    } satisfies LocalProjection;
  });

  const readRemoteMembership = Effect.fn("CodexSidebarSectionSync.readRemoteMembership")(function* (
    hostId: string,
    remoteSectionIds: readonly string[],
  ) {
    const ids = [...new Set([...remoteSectionIds, CODEX_PINNED_THREAD_SECTION_ID])];
    const sectionPages = yield* Effect.forEach(
      ids,
      (sectionId) =>
        listRemoteThreads(hostId, { kind: "section", sectionId }).pipe(
          Effect.map((threads) => [sectionId, threads] as const),
        ),
      { concurrency: 4 },
    );
    const unsectioned = yield* listRemoteThreads(hostId, { kind: "unsectioned" });
    const pages: ReadonlyArray<readonly [string | null, readonly RemoteThread[]]> = [
      ...sectionPages,
      [null, unsectioned],
    ];
    const sectionByThread = new Map<string, string | null>();
    const orderedThreadsBySection = new Map<string, readonly string[]>();
    for (const [sectionId, threads] of pages) {
      if (sectionId)
        orderedThreadsBySection.set(
          sectionId,
          threads.map((thread) => thread.id),
        );
      for (const thread of threads) sectionByThread.set(thread.id, sectionId);
    }
    return { sectionByThread, orderedThreadsBySection } satisfies RemoteMembership;
  });

  const createRemoteSection = Effect.fn("CodexSidebarSectionSync.createRemoteSection")(
    function* (input: {
      readonly hostId: string;
      readonly generation: number;
      readonly section: CoreSection;
      readonly knownRemoteSections: readonly RemoteSection[];
      readonly boundRemoteIds: ReadonlySet<string>;
    }) {
      const name = input.section.name ?? "New section";
      const candidates = input.knownRemoteSections.filter(
        (remote) => !input.boundRemoteIds.has(remote.id) && remote.name === name,
      );
      if (candidates.length === 1) return candidates[0]!;
      if (candidates.length > 1) {
        yield* upsertLink(
          hostLink({
            sectionId: input.section.section_id,
            hostId: input.hostId,
            remoteSectionId: null,
            syncState: "conflict",
            generation: input.generation,
            lastError: "Multiple unbound remote Sections share this name",
          }),
        );
        return null;
      }
      const created = yield* gateway
        .requestOnHost(input.hostId, "threadSection/create", { name, appearance: null })
        .pipe(Effect.result);
      if (created._tag === "Success") return created.success.section;

      // A transport failure can happen after the server commits. List once and bind only a unique
      // unbound same-name result; otherwise persist conflict instead of blindly creating a duplicate.
      const observed = yield* listRemoteSections(input.hostId).pipe(
        Effect.orElseSucceed(() => input.knownRemoteSections),
      );
      const recovered = observed.filter(
        (remote) => !input.boundRemoteIds.has(remote.id) && remote.name === name,
      );
      if (recovered.length === 1) return recovered[0]!;
      yield* upsertLink(
        hostLink({
          sectionId: input.section.section_id,
          hostId: input.hostId,
          remoteSectionId: null,
          syncState: "conflict",
          generation: input.generation,
          lastError: "Remote Section create outcome is ambiguous",
        }),
      );
      return null;
    },
  );

  const importRemoteSection = Effect.fn("CodexSidebarSectionSync.importRemoteSection")(function* (
    hostId: string,
    generation: number,
    remote: RemoteSection,
  ) {
    const sectionId = createUuidV7();
    yield* apply({
      kind: "create_sidebar_section",
      section_id: sectionId,
      name: normalizedRemoteName(remote.name),
      initial_item: null,
    });
    yield* upsertLink(
      hostLink({
        sectionId,
        hostId,
        remoteSectionId: remote.id,
        syncState: "ready",
        generation,
      }),
    );
    return sectionId;
  });

  const moveRemoteThread = Effect.fn("CodexSidebarSectionSync.moveRemoteThread")(function* (
    hostId: string,
    threadId: string,
    sectionId: string | null,
    beforeThreadId: string | null = null,
  ) {
    yield* gateway.requestOnHost(hostId, "thread/section/move", {
      threadId,
      sectionId,
      beforeThreadId,
    });
  });

  const reconcileHost = Effect.fn("CodexSidebarSectionSync.reconcileHost")(function* (
    hostId: string,
    _reason: SyncReason,
  ) {
    const generation = yield* readyGeneration(hostId);
    if (unsupportedGenerations.get(hostId) === generation) {
      return {
        hostId,
        generation,
        capability: "unsupported" as const,
        importedSections: 0,
        projectedThreads: 0,
      };
    }
    const sections = yield* readSections();
    let links = yield* readLinks(hostId);
    const listed = yield* listRemoteSections(hostId).pipe(Effect.result);
    if (listed._tag === "Failure" && isUnsupportedSectionCapability(listed.failure)) {
      unsupportedGenerations.set(hostId, generation);
      yield* Effect.forEach(
        sections,
        (section) => {
          const existing = links.find((link) => link.section_id === section.section_id);
          return upsertLink(
            hostLink({
              sectionId: section.section_id,
              hostId,
              remoteSectionId: existing?.remote_section_id ?? null,
              syncState: "unsupported",
              generation,
              lastError: "Host does not support Thread Sections",
            }),
          );
        },
        { discard: true },
      );
      return {
        hostId,
        generation,
        capability: "unsupported" as const,
        importedSections: 0,
        projectedThreads: 0,
      };
    }
    if (listed._tag === "Failure") return yield* listed.failure;
    unsupportedGenerations.delete(hostId);
    const remoteSections = listed.success.filter(
      (remote) => remote.id !== CODEX_PINNED_THREAD_SECTION_ID,
    );
    const remoteById = new Map(remoteSections.map((remote) => [remote.id, remote]));
    const sectionById = new Map(sections.map((section) => [section.section_id, section]));
    const localProjection = yield* readLocalProjection(hostId, sections);
    const desiredThreadCount = new Map<string, number>();
    for (const desired of localProjection.desiredLogicalSectionByThread.values()) {
      if (desired && desired !== "pinned") {
        desiredThreadCount.set(desired, (desiredThreadCount.get(desired) ?? 0) + 1);
      }
    }

    // First settle known links, deletes, renames, and lazy remote creation.
    const boundRemoteIds = new Set(
      links.flatMap((link) => (link.remote_section_id ? [link.remote_section_id] : [])),
    );
    for (const section of sections) {
      const existing = links.find((link) => link.section_id === section.section_id) ?? null;
      const remote = existing?.remote_section_id
        ? (remoteById.get(existing.remote_section_id) ?? null)
        : null;
      if (section.lifecycle === "deleted") {
        if (remote) {
          yield* gateway.requestOnHost(hostId, "threadSection/delete", { sectionId: remote.id });
        }
        if (existing) yield* deleteLink(section.section_id, hostId);
        continue;
      }
      if (existing?.sync_state === "conflict") continue;
      if (existing?.remote_section_id && !remote) {
        if (existing.sync_state === "pending") {
          const created = yield* createRemoteSection({
            hostId,
            generation,
            section,
            knownRemoteSections: remoteSections,
            boundRemoteIds,
          });
          if (created) {
            boundRemoteIds.add(created.id);
            remoteById.set(created.id, created);
            yield* upsertLink(
              hostLink({
                sectionId: section.section_id,
                hostId,
                remoteSectionId: created.id,
                syncState: "pending",
                generation,
              }),
            );
          }
        } else {
          yield* upsertLink(
            hostLink({
              sectionId: section.section_id,
              hostId,
              remoteSectionId: null,
              syncState: "conflict",
              generation,
              lastError: "Remote Section was deleted; the logical Section remains local",
            }),
          );
        }
        continue;
      }
      if (remote) {
        if (existing?.sync_state === "pending" && remote.name !== section.name) {
          const updated = yield* gateway.requestOnHost(hostId, "threadSection/update", {
            sectionId: remote.id,
            name: section.name ?? "New section",
          });
          remoteById.set(remote.id, updated.section);
        } else if (existing?.sync_state === "ready" && remote.name !== section.name) {
          yield* apply({
            kind: "rename_sidebar_section",
            section_id: section.section_id,
            name: normalizedRemoteName(remote.name),
            expected_revision: section.revision,
          });
        }
        continue;
      }
      if ((desiredThreadCount.get(section.section_id) ?? 0) === 0) continue;
      const created = yield* createRemoteSection({
        hostId,
        generation,
        section,
        knownRemoteSections: remoteSections,
        boundRemoteIds,
      });
      if (!created) continue;
      boundRemoteIds.add(created.id);
      remoteById.set(created.id, created);
      yield* upsertLink(
        hostLink({
          sectionId: section.section_id,
          hostId,
          remoteSectionId: created.id,
          syncState: "pending",
          generation,
        }),
      );
    }

    links = yield* readLinks(hostId);
    const linkedRemoteIds = new Set(
      links.flatMap((link) => (link.remote_section_id ? [link.remote_section_id] : [])),
    );
    let importedSections = 0;
    for (const remote of remoteSections) {
      if (linkedRemoteIds.has(remote.id)) continue;
      const sectionId = yield* importRemoteSection(hostId, generation, remote);
      sectionById.set(sectionId, {
        section_id: sectionId,
        kind: "custom",
        name: normalizedRemoteName(remote.name),
        rank_key: 0,
        revision: 1,
        lifecycle: "active",
        direct_item_count: 0,
        effective_session_count: 0,
        has_running: false,
        has_unread: false,
      });
      importedSections += 1;
    }

    links = yield* readLinks(hostId);
    const logicalByRemote = new Map(
      links.flatMap((link) =>
        link.remote_section_id ? [[link.remote_section_id, link.section_id] as const] : [],
      ),
    );
    const remoteByLogical = new Map(
      links.flatMap((link) =>
        link.remote_section_id ? [[link.section_id, link.remote_section_id] as const] : [],
      ),
    );
    const membership = yield* readRemoteMembership(hostId, [...logicalByRemote.keys()]);
    let projectedThreads = 0;

    // Resolve remote-only threads before applying inbound placement. This uses the canonical
    // Thread registry; RPC ids never become Session ids by convention or string guessing.
    const taskByThread = new Map(localProjection.tasks.map((task) => [task.threadId, task]));
    for (const threadId of membership.sectionByThread.keys()) {
      if (taskByThread.has(threadId)) continue;
      const entry = yield* directory.resolve({ threadId, hostId, fidelity: "durable" });
      if (!entry || entry.durable.executionHostId !== hostId) continue;
      const session = yield* catalog.ensureSession(threadId);
      if (!session) continue;
      taskByThread.set(threadId, {
        threadId,
        sessionId: session.id,
        projectId: session.projectId,
        pinned: session.pinned,
      });
    }

    const pendingLogical = new Set(
      links
        .filter((link) => link.sync_state === "pending" || link.sync_state === "delete_pending")
        .map((link) => link.section_id),
    );
    for (const task of taskByThread.values()) {
      const desiredLogical =
        localProjection.desiredLogicalSectionByThread.get(task.threadId) ?? null;
      const desiredRemote =
        desiredLogical === "pinned"
          ? CODEX_PINNED_THREAD_SECTION_ID
          : desiredLogical
            ? (remoteByLogical.get(desiredLogical) ?? null)
            : null;
      const actualRemote = membership.sectionByThread.get(task.threadId) ?? null;
      if (desiredRemote === actualRemote) continue;
      const actualLogical = actualRemote ? logicalByRemote.get(actualRemote) : null;
      const localWins =
        desiredLogical === "pinned" ||
        (typeof desiredLogical === "string" && pendingLogical.has(desiredLogical)) ||
        (actualLogical !== undefined &&
          actualLogical !== null &&
          pendingLogical.has(actualLogical));
      if (localWins) {
        yield* moveRemoteThread(hostId, task.threadId, desiredRemote);
        projectedThreads += 1;
        continue;
      }
      if (actualRemote === CODEX_PINNED_THREAD_SECTION_ID) {
        yield* catalog.setPinned(task.threadId, true);
        continue;
      }
      if (actualLogical) {
        yield* apply({
          kind: "move_sidebar_section_item",
          item: { kind: "session", session_id: task.sessionId },
          section_id: actualLogical,
          placement: { kind: "end" },
        });
        continue;
      }
      if (task.pinned) {
        yield* catalog.setPinned(task.threadId, false);
      } else if (localProjection.directSectionBySession.has(task.sessionId)) {
        yield* apply({
          kind: "move_sidebar_section_item",
          item: { kind: "session", session_id: task.sessionId },
          section_id: null,
          placement: { kind: "end" },
        });
      }
    }

    // app-server has no root Section order. It does own per-Section Thread order, projected with
    // beforeThreadId while Project rows remain a Core-only concept.
    for (const logicalSectionId of pendingLogical) {
      const remoteSectionId = remoteByLogical.get(logicalSectionId);
      if (!remoteSectionId) continue;
      const desired = localProjection.orderedThreadsByLogicalSection.get(logicalSectionId) ?? [];
      const current = membership.orderedThreadsBySection.get(remoteSectionId) ?? [];
      if (
        desired.length === current.length &&
        desired.every((id, index) => id === current[index])
      ) {
        continue;
      }
      let beforeThreadId: string | null = null;
      for (const threadId of [...desired].reverse()) {
        yield* moveRemoteThread(hostId, threadId, remoteSectionId, beforeThreadId);
        beforeThreadId = threadId;
        projectedThreads += 1;
      }
    }

    const desiredPinned = localProjection.orderedThreadsByLogicalSection.get("pinned") ?? [];
    const remotePinned =
      membership.orderedThreadsBySection.get(CODEX_PINNED_THREAD_SECTION_ID) ?? [];
    if (
      desiredPinned.length !== remotePinned.length ||
      desiredPinned.some((id, index) => id !== remotePinned[index])
    ) {
      let beforeThreadId: string | null = null;
      for (const threadId of [...desiredPinned].reverse()) {
        yield* moveRemoteThread(hostId, threadId, CODEX_PINNED_THREAD_SECTION_ID, beforeThreadId);
        beforeThreadId = threadId;
        projectedThreads += 1;
      }
    }

    yield* assertGeneration(hostId, generation);
    links = yield* readLinks(hostId);
    yield* Effect.forEach(
      links.filter(
        (link) =>
          link.remote_section_id !== null &&
          link.sync_state !== "conflict" &&
          sectionById.get(link.section_id)?.lifecycle !== "deleted",
      ),
      (link) =>
        upsertLink(
          hostLink({
            sectionId: link.section_id,
            hostId,
            remoteSectionId: link.remote_section_id ?? null,
            syncState: "ready",
            generation,
          }),
        ),
      { discard: true },
    );
    return {
      hostId,
      generation,
      capability: "supported" as const,
      importedSections,
      projectedThreads,
    };
  });

  const syncHost = (hostId: string, reason: SyncReason = "manual") =>
    Effect.scoped(
      Effect.gen(function* () {
        const lane = yield* RcMap.get(lanes, hostId);
        return yield* lane.withPermit(reconcileHost(hostId, reason));
      }),
    ).pipe(
      Effect.retry({
        schedule: retrySchedule,
        while: (error) => error instanceof CodexRuntimeError && error.retryable,
      }),
      Effect.mapError((cause) => syncError("sync-host", hostId, cause)),
    );

  const syncAll = (reason: SyncReason = "manual") =>
    executionHosts.hosts().pipe(
      Effect.flatMap((hosts) =>
        Effect.forEach(
          hosts,
          (host) =>
            syncHost(host.hostId, reason).pipe(
              Effect.tap(() =>
                Effect.sync(() => activeFailureEpisodes.delete(host.hostId)).pipe(
                  Effect.flatMap((recovered) =>
                    recovered
                      ? Effect.logInfo("Sidebar Section host reconciliation recovered").pipe(
                          Effect.annotateLogs({ hostId: host.hostId, reason }),
                        )
                      : Effect.void,
                  ),
                ),
              ),
              Effect.catch((error) =>
                Effect.sync(() => {
                  const identity = syncFailureIdentity(error);
                  if (activeFailureEpisodes.get(host.hostId) === identity) return false;
                  activeFailureEpisodes.set(host.hostId, identity);
                  return true;
                }).pipe(
                  Effect.flatMap((shouldLog) =>
                    shouldLog
                      ? Effect.logWarning("Sidebar Section host reconciliation failed").pipe(
                          Effect.annotateLogs({ hostId: host.hostId, reason, error }),
                        )
                      : Effect.void,
                  ),
                  Effect.as(null),
                ),
              ),
            ),
          { concurrency: 3 },
        ),
      ),
      Effect.map((results) =>
        results.filter((result): result is CodexSidebarSectionHostSyncResult => result !== null),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Sidebar Section host discovery failed").pipe(
          Effect.annotateLogs({ reason, cause }),
          Effect.as([] as readonly CodexSidebarSectionHostSyncResult[]),
        ),
      ),
    );

  const request = (reason: SyncReason) => Queue.offer(signals, reason).pipe(Effect.asVoid);
  const service = CodexSidebarSectionSync.of({ request, syncHost, syncAll });

  yield* Queue.take(signals).pipe(
    Effect.flatMap((reason) => syncAll(reason)),
    Effect.forever,
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Effect.sleep("30 seconds").pipe(
    Effect.andThen(request("periodic")),
    Effect.forever,
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* gateway.events.pipe(
    Stream.filter((event) => event.kind === "connection" && event.value.kind === "ready"),
    Stream.runForEach(() => request("connection-ready")),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* request("startup");
  return service;
});

export const live: Layer.Layer<
  CodexSidebarSectionSync,
  never,
  CodexGateway | CodexThreadCatalog | CodexThreadDirectory | CoreModules | ExecutionHostRuntime
> = Layer.effect(CodexSidebarSectionSync, make);
