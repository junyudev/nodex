import { isCodexAgentBackendBinding, type AgentBackendBinding } from "../../shared/agent-backend";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import type { ThreadExecutionLocationView } from "../../shared/codex-thread-handoff";
import type { CodexThreadSummary } from "../../shared/types";

/** The Session facts that decide which execution owner a surface addresses. */
export interface SessionExecutionSource {
  readonly id: string;
  readonly projectId: string | null;
  readonly displayTitle: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly thread: {
    readonly threadId: string;
    readonly executionHostId: string;
    readonly backendBinding: AgentBackendBinding;
    readonly parentThreadId?: string | null;
    readonly cwd?: string | null;
    readonly managedWorktreePath?: string | null;
  } | null;
  readonly executionRef?: { readonly runtimeId: string; readonly threadId: string } | null;
}

export interface SessionExecutionLocation {
  readonly cwd: string | null;
  readonly managedWorktreePath: string | null;
}

/**
 * One classification for every Session surface. A Runtime-bound Session executes through its
 * immutable root Thread; a native Session keeps its imported or remote Thread; an unstarted
 * Session has no conversation yet. Live status and Runtime location are read separately.
 */
export type SessionExecution =
  | { readonly kind: "unstarted"; readonly sessionId: string }
  | {
      readonly kind: "runtime";
      readonly sessionId: string;
      readonly runtimeId: string;
      readonly rootThreadId: string;
    }
  | {
      readonly kind: "native";
      readonly sessionId: string;
      readonly rootThreadId: string;
      readonly hostId: string;
      readonly backendBinding: AgentBackendBinding;
      readonly parentThreadId: string | null;
      readonly location: SessionExecutionLocation;
    };

export function resolveSessionExecution(session: SessionExecutionSource): SessionExecution {
  if (session.executionRef)
    return {
      kind: "runtime",
      sessionId: session.id,
      runtimeId: session.executionRef.runtimeId,
      rootThreadId: session.executionRef.threadId,
    };
  if (session.thread)
    return {
      kind: "native",
      sessionId: session.id,
      rootThreadId: session.thread.threadId,
      hostId: session.thread.executionHostId,
      backendBinding: session.thread.backendBinding,
      parentThreadId: session.thread.parentThreadId ?? null,
      location: {
        cwd: normalizePath(session.thread.cwd),
        managedWorktreePath: normalizePath(session.thread.managedWorktreePath),
      },
    };
  return { kind: "unstarted", sessionId: session.id };
}

/** The root Thread every conversation-scoped surface addresses, or null before launch. */
export function sessionExecutionThreadId(session: SessionExecutionSource | null): string | null {
  if (!session) return null;
  const execution = resolveSessionExecution(session);
  return execution.kind === "unstarted" ? null : execution.rootThreadId;
}

/** Runtime-bound Sessions read live status and location from their execution owner. */
export function runtimeSessionTarget(
  session: Pick<SessionExecutionSource, "id" | "executionRef"> | null | undefined,
): { readonly sessionId: string; readonly rootThreadId: string } | null {
  return session?.executionRef
    ? { sessionId: session.id, rootThreadId: session.executionRef.threadId }
    : null;
}

/** Summary, Review, find and chat commands require a conversation, not a particular owner. */
export function hasSessionConversation(session: SessionExecutionSource | null): boolean {
  return sessionExecutionThreadId(session) !== null;
}

export function runtimeExecutionLocation(
  location: ThreadExecutionLocationView,
): SessionExecutionLocation {
  return {
    cwd: normalizePath(location.cwd),
    managedWorktreePath: normalizePath(location.managedWorktreePath),
  };
}

/** Native location is Core metadata; Runtime location is read from its execution owner. */
export function resolveSessionExecutionLocation(
  execution: SessionExecution,
  runtimeLocation: ThreadExecutionLocationView | null | undefined,
): SessionExecutionLocation | null {
  if (execution.kind === "native") return execution.location;
  if (execution.kind === "runtime" && runtimeLocation)
    return runtimeExecutionLocation(runtimeLocation);
  return null;
}

export type SessionMarkdownExport =
  | {
      readonly kind: "runtime";
      readonly target: { readonly sessionId: string; readonly threadId: string };
    }
  | {
      readonly kind: "native";
      readonly conversationId: string;
      readonly executionHostId: string;
      readonly parentConversationId: string | null;
    };

/** Runtime chats export through paged Runtime reads; native export remains Codex-only. */
export function resolveSessionMarkdownExport(
  execution: SessionExecution,
): SessionMarkdownExport | null {
  if (execution.kind === "runtime")
    return {
      kind: "runtime",
      target: { sessionId: execution.sessionId, threadId: execution.rootThreadId },
    };
  if (execution.kind === "native" && isCodexAgentBackendBinding(execution.backendBinding))
    return {
      kind: "native",
      conversationId: execution.rootThreadId,
      executionHostId: execution.hostId,
      parentConversationId: execution.parentThreadId,
    };
  return null;
}

export type SessionProjectMove =
  | { readonly kind: "runtime"; readonly sessionId: string }
  | { readonly kind: "codex-thread"; readonly threadId: string };

/**
 * Runtime Sessions move their product placement and keep their root; native Codex Threads move
 * through the sidebar Thread owner. Other native history and unstarted drafts stay in place.
 */
export function resolveSessionProjectMove(execution: SessionExecution): SessionProjectMove | null {
  if (execution.kind === "runtime") return { kind: "runtime", sessionId: execution.sessionId };
  if (execution.kind === "native" && isCodexAgentBackendBinding(execution.backendBinding))
    return { kind: "codex-thread", threadId: execution.rootThreadId };
  return null;
}

export type SessionPageSendTarget =
  /** The Session already has a conversation; sending adds a message to it. */
  | { readonly kind: "thread"; readonly thread: CodexThreadSummary }
  /** The unstarted Session in this Page's Project launches with the Page linked. */
  | { readonly kind: "launch" }
  | { readonly kind: "none" };

/**
 * A bound Runtime Session is always an existing-conversation target: launching it again would
 * be rejected after side effects. Native Threads keep their Core projection.
 */
export function resolveSessionPageSendTarget(
  session: SessionExecutionSource,
  pageProjectId: string,
  nativeThread: CodexThreadSummary | null,
): SessionPageSendTarget {
  const execution = resolveSessionExecution(session);
  if (execution.kind === "runtime")
    return { kind: "thread", thread: runtimeSessionThreadSummary(session, execution.rootThreadId) };
  if (execution.kind === "native")
    return nativeThread ? { kind: "thread", thread: nativeThread } : { kind: "none" };
  return session.projectId === pageProjectId ? { kind: "launch" } : { kind: "none" };
}

/** A metadata-only thread descriptor for editor targets; it carries no execution status. */
export function runtimeSessionThreadSummary(
  session: SessionExecutionSource,
  rootThreadId: string,
): CodexThreadSummary {
  return {
    threadId: rootThreadId,
    projectId: session.projectId,
    executionHostId: "local",
    source: null,
    threadName: session.displayTitle,
    threadPreview: "",
    cwd: null,
    statusType: "notLoaded",
    statusActiveFlags: [],
    archived: session.archived,
    createdAt: Date.parse(session.createdAt) || 0,
    updatedAt: Date.parse(session.updatedAt) || 0,
    linkedAt: session.createdAt,
  };
}

export type SessionLiveIndicator = "running" | "waiting" | "background";

/** Runtime activity is the only live-status source for Runtime Sessions; idle is absent. */
export function runtimeSessionLiveIndicator(
  activity: Pick<AgentRuntimeSessionActivity, "status"> | null | undefined,
): SessionLiveIndicator | null {
  return activity?.status ?? null;
}

export const SESSION_LIVE_INDICATOR_LABELS: Readonly<Record<SessionLiveIndicator, string>> = {
  running: "Running",
  waiting: "Needs attention",
  background: "Working in background",
};

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
