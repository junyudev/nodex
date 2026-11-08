import { automaticModelCatalog, modelIsOn } from "../../shared/model-policy";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentCatalog, ChatActivity, ChatSummary } from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { z } from "zod";
import {
  inboxDefaultChatModel,
  isInboxChatCandidate,
  resolveInboxModel as resolveFromCatalog,
  type InboxAgentChoice,
} from "../../shared/inbox";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { summaryOf, withSessionMetadata } from "../app-tools/SessionDiscovery";
import {
  type ChatListingItem,
  type ChatRuntimeMetadata,
} from "../chat-search/ChatCatalogProjection";
import { ChatSearch } from "../chat-search/ChatSearch";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreModules } from "../core-runtime/CoreModules";
import { InboxApplication } from "../inbox-application/InboxApplication";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { mobileAgentChoice } from "./inbox";
import { idleActivity, nativeActivity, runtimeActivity } from "./transcript-projection";
import { invalid, rpcError, unavailable, type MobileHandlers } from "./rpc";

type Providers = AgentRuntimeOperations["providers.read"]["output"];
const runtimeUnavailable = () => unavailable("The Agent catalog is temporarily unavailable.");
const listUnavailable = () => unavailable("The chat list is temporarily unavailable.");

const providerReason = (provider: Providers[number]): string | null => {
  if (!provider.enabled) return "This Agent is off.";
  if (!provider.installed) return "This Agent isn't available on your desktop.";
  if (provider.auth.status === "unauthenticated")
    return "Sign in on your desktop to use this Agent.";
  if (provider.availability === "unavailable" || provider.status === "error")
    return "This Agent is temporarily unavailable.";
  return provider.models.length ? null : "This Agent has no available models.";
};

export const projectAgentCatalog = (
  providers: Providers,
  preference: InboxAgentChoice,
): AgentCatalog => {
  const preferred = resolveFromCatalog(providers, preference, "chat");
  const fallback = automaticModelCatalog(providers).find(
    (provider) => isInboxChatCandidate(provider) && !providerReason(provider),
  );
  const fallbackModel = fallback && inboxDefaultChatModel(fallback);
  return {
    providers: providers.map((provider) => ({
      instanceId: provider.instanceId,
      label: provider.displayName ?? provider.instanceId,
      unavailableReason: providerReason(provider),
      models: provider.models
        .filter(modelIsOn)
        .map((model) => ({ id: model.slug, label: model.name })),
    })),
    defaultChoice:
      preferred.kind === "ready" && !providerReason(preferred.provider)
        ? { providerInstanceId: preferred.selection.instanceId, model: preferred.selection.model }
        : fallback && fallbackModel
          ? { providerInstanceId: fallback.instanceId, model: fallbackModel.slug }
          : null,
  };
};

export const projectChatRow = (
  row: ChatListingItem,
  metadata: ChatRuntimeMetadata | undefined,
  live: ChatActivity | undefined,
): ChatSummary => {
  const base = summaryOf(row);
  const entry = metadata ? withSessionMetadata(base, metadata) : base;
  const activity =
    live ?? nativeActivity(entry.sessionId, entry.status.status_type, entry.status.active_flags);
  return {
    ...activity,
    title: entry.title,
    preview: Array.from(entry.preview).slice(0, 240).join(""),
    projectId: entry.projectId,
    projectName: entry.projectName,
    agentLabel: entry.agent?.model ?? (entry.binding?.kind === "native" ? "Codex" : null),
    unread: row.task.session.unread,
    pinned: entry.pinned,
    archived: entry.archived,
    activityAt: row.task.session.activity_at,
    canSend: entry.binding?.kind === "runtime" && !entry.archived,
  };
};

const searchCursor = z.object({ scope: z.string(), lastSessionId: z.string() });

export const rankedChatPage = (
  ids: readonly string[],
  scope: string,
  cursor: string | null | undefined,
  first: number,
) => {
  let start = 0;
  if (cursor) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(cursor);
    } catch {
      return null;
    }
    const parsed = searchCursor.safeParse(decoded);
    if (!parsed.success || parsed.data.scope !== scope) return null;
    start = ids.indexOf(parsed.data.lastSessionId) + 1;
    if (start === 0) return null;
  }
  const sessionIds = ids.slice(start, start + first);
  const lastSessionId = sessionIds.at(-1);
  return {
    sessionIds,
    nextCursor:
      lastSessionId && start + sessionIds.length < ids.length
        ? JSON.stringify({ scope, lastSessionId })
        : null,
  };
};

/** Of the chats a phone asks about, the ones the chat list still shows as unread. */
export const unreadChats =
  (core: CoreModules["Service"]): MobileHandlers["chats.unread"] =>
  ({ sessionIds }) =>
    Effect.gen(function* () {
      if (sessionIds.length === 0) return { sessionIds: [] };
      // The chat list's own membership rules decide, so an archived or hidden chat is not unread.
      const response = yield* core.workspace
        .read({
          kind: "session_window",
          archived: false,
          order: "identity",
          session_ids: [...new Set(sessionIds)],
          window: { first: 100 },
        })
        .pipe(Effect.mapError(listUnavailable));
      if (response.value.kind !== "session_window") return yield* Effect.fail(listUnavailable());
      return {
        sessionIds: response.value.sessions.items
          .filter((row) => row.task.session.unread)
          .map((row) => row.task.session.id),
      };
    });

export const makeMobileCatalog = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const activity = yield* AgentRuntimeSessionActivity;
  const inbox = yield* InboxApplication;
  const workspace = yield* ProjectWorkspace;
  const settings = yield* ApplicationSettings;
  const git = yield* CodexGitProbe;
  const search = yield* ChatSearch;

  const agents: MobileHandlers["agents.catalog"] = () =>
    Effect.gen(function* () {
      const [providers, snapshot] = yield* Effect.all([
        runtime.catalog(),
        settings.snapshot(),
      ]).pipe(Effect.mapError(runtimeUnavailable));
      return projectAgentCatalog(providers, snapshot.inbox.chatAgent);
    });
  const agentChoice = Effect.fn("MobileCatalog.agentChoice")(function* (
    choice: Parameters<MobileHandlers["chats.start"]>[0]["agent"],
  ) {
    const catalog = yield* agents({});
    if (choice) return mobileAgentChoice(choice);
    if (catalog.defaultChoice) {
      const snapshot = yield* settings.snapshot().pipe(Effect.mapError(runtimeUnavailable));
      if (snapshot.inbox.chatAgent.instanceId === catalog.defaultChoice.providerInstanceId)
        return { ...snapshot.inbox.chatAgent, model: catalog.defaultChoice.model };
      return mobileAgentChoice(catalog.defaultChoice);
    }
    return yield* Effect.fail(unavailable("No Agent is ready on the Desktop Host."));
  });

  const projects: MobileHandlers["projects.list"] = () =>
    Effect.gen(function* () {
      const [projects, counts] = yield* Effect.all([workspace.listProjects, inbox.counts]).pipe(
        Effect.mapError(() => unavailable("Projects are temporarily unavailable.")),
      );
      return {
        projects: yield* Effect.forEach(
          projects,
          (project) =>
            Effect.gen(function* () {
              const root = project.primaryWorkspaceRoot;
              const gitRoot = root
                ? yield* git.readPath(root, ["rev-parse", "--show-toplevel"])
                : null;
              return {
                id: project.id,
                name: project.name,
                supportsWorktree: gitRoot !== null,
                inboxCount: counts.projects[project.id] ?? 0,
              };
            }),
          { concurrency: 4 },
        ),
        libraryInboxCount: counts.library,
      };
    });

  const unread = unreadChats(core);

  const chats: MobileHandlers["chats.list"] = (input) =>
    Effect.gen(function* () {
      const query = input.query?.trim();
      if ((query?.length ?? 0) > 200 || (input.after?.length ?? 0) > 4096)
        return yield* Effect.fail(invalid("The chat search or cursor is too long."));
      const archived = input.archived ?? false;
      const first = input.first ?? 50;
      const ranked = yield* Effect.gen(function* () {
        if (!query) return null;
        const scope = JSON.stringify([
          query,
          archived,
          input.projectId ?? null,
          input.projectId === null,
        ]);
        const ids = yield* search
          .rankSessionIds({ query, archived, projectId: input.projectId })
          .pipe(Effect.mapError(listUnavailable));
        const page = rankedChatPage(ids, scope, input.after, first);
        if (!page)
          return yield* Effect.fail(
            rpcError("conflict", "Refresh the chat search to continue.", true),
          );
        return page;
      });
      if (ranked && ranked.sessionIds.length === 0) return { items: [], nextCursor: null };
      const readPage = (after: string | null) =>
        core.workspace
          .read({
            kind: "session_window",
            archived,
            order: "conversation",
            ...(input.projectId === null ? { projectless_only: true } : {}),
            ...(typeof input.projectId === "string" ? { project_id: input.projectId } : {}),
            ...(ranked ? { session_ids: ranked.sessionIds } : {}),
            window: { after, first },
          })
          .pipe(
            Effect.mapError((error) =>
              error.cause instanceof CoreModuleResponseError &&
              error.cause.coreError.code === "invalid_input"
                ? invalid("The chat list cursor is invalid.")
                : listUnavailable(),
            ),
          );
      const response = yield* readPage(ranked ? null : (input.after ?? null));
      if (response.value.kind !== "session_window") return yield* Effect.fail(listUnavailable());
      const page = response.value.sessions;
      let rows = [...page.items];
      if (ranked) {
        let next = page.next_cursor ?? null;
        const cursors = new Set<string>();
        while (next) {
          if (cursors.has(next)) return yield* Effect.fail(listUnavailable());
          cursors.add(next);
          const continuation = yield* readPage(next);
          if (continuation.value.kind !== "session_window")
            return yield* Effect.fail(listUnavailable());
          rows.push(...continuation.value.sessions.items);
          next = continuation.value.sessions.next_cursor ?? null;
        }
        const byId = new Map(rows.map((row) => [row.task.session.id, row]));
        rows = ranked.sessionIds.flatMap((id) => {
          const row = byId.get(id);
          return row ? [row] : [];
        });
      }
      const byRuntime = new Map<string, string[]>();
      for (const row of rows) {
        const ref = row.task.session.execution_ref;
        if (!ref) continue;
        const ids = byRuntime.get(ref.runtime_id);
        if (ids) ids.push(ref.thread_id);
        else byRuntime.set(ref.runtime_id, [ref.thread_id]);
      }
      const metadata = new Map(
        (yield* Effect.forEach(byRuntime, ([runtimeId, threadIds]) =>
          runtime.sessionMetadata({ runtimeId, threadIds }).pipe(
            Effect.map((items) =>
              items.map((item) => [`${runtimeId}\0${item.threadId}`, item] as const),
            ),
            Effect.orElseSucceed(() => []),
          ),
        )).flat(),
      );
      const live = new Map(
        (yield* activity.read).items.map((item) => [item.sessionId, runtimeActivity(item)]),
      );
      return {
        items: rows.map((row) => {
          const ref = row.task.session.execution_ref;
          return projectChatRow(
            row,
            ref ? metadata.get(`${ref.runtime_id}\0${ref.thread_id}`) : undefined,
            live.get(row.task.session.id),
          );
        }),
        nextCursor: ranked ? ranked.nextCursor : (page.next_cursor ?? null),
      };
    });

  const observeActivity = (push: (data: ChatActivity) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const known = new Map<string, ChatActivity>();
      const load = Effect.gen(function* () {
        const snapshot = yield* activity.read;
        const next = new Map(snapshot.items.map((item) => [item.sessionId, runtimeActivity(item)]));
        if (snapshot.complete) {
          for (const id of known.keys()) if (!next.has(id)) yield* push(idleActivity(id));
          known.clear();
        }
        for (const [id, data] of next) {
          known.set(id, data);
          yield* push(data);
        }
        return snapshot.sequence;
      });
      const initial = yield* activity.read;
      for (const item of initial.items) known.set(item.sessionId, runtimeActivity(item));
      let floor = initial.sequence;
      yield* activity.activityChanges.pipe(
        Stream.runForEach((change) =>
          Effect.gen(function* () {
            if (change.sequence <= floor) return;
            if (change.type === "reset" || change.sequence !== floor + 1) {
              if (change.type === "remove" && !known.has(change.sessionId))
                yield* push(idleActivity(change.sessionId));
              floor = yield* load;
              return;
            }
            floor = change.sequence;
            if (change.type === "upsert") {
              const data = runtimeActivity(change.activity);
              known.set(data.sessionId, data);
              yield* push(data);
            } else {
              known.delete(change.sessionId);
              yield* push(idleActivity(change.sessionId));
            }
          }),
        ),
      );
    });
  return { projects, agents, chats, unread, agentChoice, observeActivity };
});
