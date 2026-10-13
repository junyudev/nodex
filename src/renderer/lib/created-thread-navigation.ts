import type {
  CodexCreatedThreadResolveInput,
  CodexCreatedThreadResolution,
} from "../../shared/codex-child-thread-summary";
import type { ProjectSession } from "../../shared/types";

export type CreatedThreadNavigation =
  | { readonly type: "pending"; readonly hostId: string; readonly clientThreadId: string }
  | {
      readonly type: "session";
      readonly resolution: CodexCreatedThreadResolution | null;
      readonly session: ProjectSession;
    }
  | { readonly type: "child"; readonly resolution: CodexCreatedThreadResolution };

/** A resolved host and launch receipt precede Session creation or local scope registration. */
export async function prepareCreatedThreadNavigation(
  input: CodexCreatedThreadResolveInput,
  ports: {
    readonly resolve: (
      input: CodexCreatedThreadResolveInput,
    ) => Promise<CodexCreatedThreadResolution | null>;
    readonly ensureOpen: (input: {
      readonly hostId: string;
      readonly threadId: string;
    }) => Promise<ProjectSession | null>;
  },
): Promise<CreatedThreadNavigation | null> {
  const resolution = await ports.resolve(input);
  if (!resolution) {
    if (!("threadId" in input) || input.expectedHostId === undefined) return null;
    const session = await ports.ensureOpen({
      hostId: input.expectedHostId,
      threadId: input.threadId,
    });
    if (!isConfirmedRoot(session, input.expectedHostId, input.threadId)) return null;
    // Only the guarded Main command can establish a missing root; no query receipt is invented.
    return { type: "session", resolution: null, session };
  }
  if (input.expectedHostId !== undefined && input.expectedHostId !== resolution.hostId) return null;
  if ("threadId" in input && input.threadId !== resolution.threadId) return null;
  if ("clientThreadId" in input && resolution.clientThreadId !== input.clientThreadId) return null;
  if (!resolution.ready)
    return "clientThreadId" in input
      ? { type: "pending", hostId: resolution.hostId, clientThreadId: input.clientThreadId }
      : null;
  if (!resolution.threadId) return null;
  if (resolution.parentThreadId !== null) return { type: "child", resolution };
  const session = await ports.ensureOpen({
    hostId: resolution.hostId,
    threadId: resolution.threadId,
  });
  if (!isConfirmedRoot(session, resolution.hostId, resolution.threadId)) return null;
  return { type: "session", resolution, session };
}

function isConfirmedRoot(
  session: ProjectSession | null,
  hostId: string,
  threadId: string,
): session is ProjectSession {
  return (
    session !== null &&
    session.thread?.backendBinding.kind === "codex" &&
    session.thread.threadId === threadId &&
    session.thread.executionHostId === hostId &&
    !session.thread.parentThreadId
  );
}
