import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import {
  AgentRuntimeSessionActivity,
  inactive,
} from "../agent-runtime/AgentRuntimeSessionActivity";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexInternalThreadRegistry } from "../codex-application/CodexInternalThreadRegistry";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { ProjectWorkspaceRead } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { make } from "./ChatSearch";
import type { ChatListingItem, ChatRuntimeMetadata } from "./ChatCatalogProjection";

export const at = "2026-10-01T00:00:00.000Z";
export const row = (
  id: string,
  title = "Other subject",
  kind: "runtime" | "native" | "empty" = "runtime",
): ChatListingItem =>
  ({
    cursor: id,
    task: {
      session: {
        id,
        project_id: "project",
        display_title: title,
        no_thread_fallback_title: title,
        activity_at: 0,
        pinned: false,
        pinned_order: null,
        archived: false,
        archived_at: null,
        unread: false,
        created_at: at,
        updated_at: at,
        thread_id: kind === "native" ? id : null,
        ...(kind === "runtime" ? { execution_ref: { runtime_id: "runtime", thread_id: id } } : {}),
      },
      thread:
        kind === "native"
          ? {
              thread_id: id,
              project_id: "project",
              session_id: id,
              parent_thread_id: null,
              backend_binding: { kind: "codex" },
              execution_host_id: "local",
              thread_preview: "Opening prompt",
              status: { status_type: "idle", active_flags: [] },
              archived: false,
              created_at: Date.parse(at),
              updated_at: Date.parse(at),
              recency_at: Date.parse(at),
              cwd: "/workspace",
            }
          : null,
    },
    project_name: "Project",
    project_pinned: false,
    direct_section_id: null,
    project_section_id: null,
    opens: null,
  }) as ChatListingItem;
export const metadata = (
  id: string,
  overrides: Partial<ChatRuntimeMetadata> = {},
): ChatRuntimeMetadata => ({
  threadId: id,
  activeFlags: [],
  createdAt: at,
  preview: "Opening prompt",
  recencyAt: at,
  latestUserAuthoredMessageAt: at,
  updatedAt: at,
  activeRunId: null,
  worktreePath: null,
  titleRegeneration: null,
  createdBy: "user",
  creationSource: "web",
  runtimeMode: "full-access",
  interactionMode: "default",
  latestRunId: null,
  runStatus: "completed",
  activityRunStatus: null,
  providerInstanceId: "claude",
  providerDriver: "claudeAgent",
  model: "model",
  parentThreadId: null,
  relationshipToParent: null,
  rootThreadId: id,
  branch: null,
  settled: false,
  settledAt: null,
  snoozed: false,
  snoozedUntil: null,
  pullRequests: [],
  itemCount: 0,
  itemCountCoverage: "complete",
  ...overrides,
});
export type Fact = AgentRuntimeOperations["sessions.search"]["output"]["items"][number];
export const fact = (
  id: string,
  snippet = "needle in history",
  changes: Partial<Fact> = {},
): Fact => ({
  threadId: id,
  itemId: `item:${id}`,
  messageId: `message:${id}`,
  runId: null,
  source: "user",
  snippet,
  messageAt: at,
  cursor: id,
  quality: 1,
  hits: 1,
  contentVersion: "a".repeat(43),
  ...changes,
});

interface Options {
  readonly rows?: () => readonly ChatListingItem[];
  readonly metadata?: (id: string) => ChatRuntimeMetadata;
  readonly read?: CoreModules["Service"]["workspace"]["read"];
  readonly invalidations?: Stream.Stream<unknown>;
  readonly search?: AgentRuntimeApplication["Service"]["sessionSearch"];
  readonly resolve?: AgentRuntimeApplication["Service"]["sessionSearchResolve"];
  readonly codex?: CodexGateway["Service"]["requestLocal"];
  readonly ready?: boolean;
}
export const fixture = (options: Options = {}) => {
  const reads: ProjectWorkspaceRead[] = [];
  const agents: unknown[] = [];
  const runtime = {
    sessionMetadata: ({ threadIds }: { threadIds: readonly string[] }) =>
      Effect.succeed(threadIds.map((id) => (options.metadata ?? metadata)(id))),
    sessionSearch:
      options.search ??
      (() =>
        Effect.succeed({
          runtimeId: "runtime",
          items: [],
          nextCursor: null,
          coverage: "indexed",
          startCursor: null,
        })),
    sessionSearchResolve:
      options.resolve ?? (() => Effect.succeed({ runtimeId: "runtime", items: [] })),
  } as unknown as AgentRuntimeApplication["Service"];
  const core = {
    workspace: {
      read:
        options.read ??
        ((request: ProjectWorkspaceRead) =>
          Effect.gen(function* () {
            agents.push(yield* CoreApplicationAgent);
            reads.push(request);
            if (request.kind !== "session_window")
              throw new Error(`Unexpected Core read ${request.kind}`);
            const eligible = (options.rows?.() ?? []).filter(
              (item) => !item.task.session.archived && !item.task.thread?.parent_thread_id,
            );
            const offset = request.window.after ? Number(request.window.after) : 0;
            const selected = eligible.slice(offset, offset + (request.window.first ?? 100));
            return {
              value: {
                kind: "session_window",
                sessions: {
                  items: selected,
                  next_cursor:
                    offset + selected.length < eligible.length
                      ? String(offset + selected.length)
                      : null,
                },
              },
            };
          })),
    },
  } as CoreModules["Service"];
  const service = make.pipe(
    Effect.provideService(CoreModules, core),
    Effect.provideService(AgentRuntimeApplication, runtime),
    Effect.provideService(CodexGateway, {
      localHostId: "local",
      connection: () =>
        Effect.succeed(
          options.ready === false
            ? { kind: "idle" }
            : { kind: "ready", hostId: "local", generation: 1 },
        ),
      requestLocal: options.codex ?? (() => Effect.succeed({ data: [], nextCursor: null })),
    } as unknown as CodexGateway["Service"]),
    Effect.provideService(CodexInternalThreadRegistry, {
      shouldSuppress: () => false,
      classification: () => null,
    } as unknown as CodexInternalThreadRegistry["Service"]),
    Effect.provideService(DatabaseNotifierRuntime, {
      projectSessionInvalidations: options.invalidations ?? Stream.never,
    } as DatabaseNotifierRuntime["Service"]),
    Effect.provideService(CodexApplicationEventHub, {
      events: Stream.never,
      publish: () => undefined,
    }),
    Effect.provideService(AgentRuntimeSessionActivity, inactive),
  );
  return { service, reads, agents };
};
