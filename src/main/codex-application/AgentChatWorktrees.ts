import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import { isAgentExecutionThreadId } from "../../shared/agent-runtime-api";
import type { DesktopManagedWorktreeLifecycleConsumer } from "../core-client/project-workspace-adapter";

/** An Agent chat working in a managed worktree, described like a native Thread consumer. */
export interface AgentChatWorktreeConsumer extends DesktopManagedWorktreeLifecycleConsumer {
  readonly title: string;
}

/** A managed worktree whose owner metadata names the Thread working in it. */
export interface ManagedWorktreeOwner {
  readonly hostId: string;
  readonly worktreeGitRoot: string;
  readonly ownerThreadId: string;
}

/** Where an Agent chat works, for checking and restoring its managed worktree. */
export interface AgentChatWorkLocation {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly cwd: string;
}

/** Agent execution's view of the Agent chats that own managed worktrees. */
export interface AgentChatWorktreeSource {
  /**
   * The Agent chats owning these worktrees, shaped like the native Thread consumers Core
   * reports. Owners whose chat no longer exists are omitted; a read failure fails.
   */
  readonly consumers: (
    owners: readonly ManagedWorktreeOwner[],
  ) => Effect.Effect<readonly AgentChatWorktreeConsumer[], unknown>;
  /** The chat's working location, or null when it has none on this device. */
  readonly location: (threadId: string) => Effect.Effect<AgentChatWorkLocation | null, unknown>;
  /** Archives the chat whose worktree is being deleted. */
  readonly archive: (threadId: string) => Effect.Effect<void, unknown>;
}

export class AgentChatWorktreesUnavailable extends Data.TaggedError(
  "AgentChatWorktreesUnavailable",
)<{}> {}

/**
 * Managed worktrees outlive the processes that create them. Native Threads are described by
 * Core; Agent chats are described by Agent execution once it starts. Until then, callers
 * cannot tell an Agent chat's worktree from an abandoned one and must not act on it.
 */
export class AgentChatWorktrees extends Context.Service<
  AgentChatWorktrees,
  {
    /** Agent execution describes its chats for the lifetime of the calling scope. */
    readonly register: (source: AgentChatWorktreeSource) => Effect.Effect<void, never, Scope.Scope>;
    readonly source: Effect.Effect<AgentChatWorktreeSource, AgentChatWorktreesUnavailable>;
  }
>()("nodex/main/codex-application/AgentChatWorktrees") {}

export const make = Effect.gen(function* () {
  const current = yield* Ref.make<AgentChatWorktreeSource | null>(null);
  return AgentChatWorktrees.of({
    register: (source) =>
      Effect.acquireRelease(Ref.set(current, source), () => Ref.set(current, null)),
    source: Ref.get(current).pipe(
      Effect.flatMap((source) =>
        source ? Effect.succeed(source) : Effect.fail(new AgentChatWorktreesUnavailable()),
      ),
    ),
  });
});

export const live = Layer.effect(AgentChatWorktrees, make);

/** The Agent chats among these owners, read only when there are any. */
export const agentChatWorktreeConsumers = (
  chats: AgentChatWorktrees["Service"],
  owners: readonly ManagedWorktreeOwner[],
): Effect.Effect<readonly AgentChatWorktreeConsumer[], unknown> => {
  const agentOwners = owners.filter((owner) => isAgentExecutionThreadId(owner.ownerThreadId));
  if (agentOwners.length === 0) return Effect.succeed([]);
  return chats.source.pipe(Effect.flatMap((source) => source.consumers(agentOwners)));
};
