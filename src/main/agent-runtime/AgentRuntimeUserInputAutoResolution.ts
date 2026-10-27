import type { AgentRuntimeIdentity, AgentSnapshot } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { CodexUserInputAutoResolution } from "../codex-application/CodexUserInputAutoResolution";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";

type RuntimeRequest = AgentSnapshot["projection"]["runtimeRequests"][number];
interface RuntimeLease {
  readonly connection: AgentRuntimeProcessConnection;
  readonly fence: { readonly hostId: string; readonly generation: number };
}

const isNonblockingLiveQuestion = (request: RuntimeRequest) =>
  request.kind === "user_input" &&
  request.status === "pending" &&
  request.responseCapability.type === "live" &&
  request.isBlocking === false;

/**
 * Adapts Runtime live questions to the shared host deadline owner. It reads control metadata,
 * never transcript bodies, and responds only through the process generation that asked.
 */
export const make = Effect.fn("AgentRuntimeUserInputAutoResolution.make")(function* (options: {
  readonly transitions: Stream.Stream<AgentRuntimeActivityTransition>;
}) {
  const deadlines = yield* CodexUserInputAutoResolution;
  const mutations = yield* Semaphore.make(1);
  const leases = new Map<AgentRuntimeIdentity, RuntimeLease>();
  let nextGeneration = 0;

  const reconcile = (lease: RuntimeLease, rootThreadId: string) =>
    mutations.withPermits(1)(
      Effect.gen(function* () {
        if (leases.get(lease.connection.identity) !== lease) return;
        const snapshot = yield* lease.connection.request("thread.control", {
          threadId: rootThreadId,
        });
        if (leases.get(lease.connection.identity) !== lease) return;
        const request = snapshot.projection.runtimeRequests.findLast(isNonblockingLiveQuestion);
        if (!request) {
          yield* deadlines.reconcilePendingRequests(
            { hostId: "local", conversationId: rootThreadId },
            [],
          );
          return;
        }
        // Codex's deprecated autoResolutionMs does not override the live-question policy.
        // Inactivity, presentation changes and snooze all belong to the existing deadline owner.
        yield* deadlines.observeRequest(rootThreadId, request.id, lease.fence, {
          hostId: "local",
          responseKind: "runtimeUserInput",
        });
      }),
    );
  const warn = (operation: string) => (cause: unknown) =>
    Effect.logWarning("Agent question deadline could not be updated").pipe(
      Effect.annotateLogs({ operation, cause }),
    );

  yield* options.transitions.pipe(
    Stream.runForEach((transition) => {
      const lease = leases.get(transition.connection.identity);
      if (!lease) return Effect.void;
      if ((transition.after?.pendingRequestCount ?? 0) > 0)
        return reconcile(lease, transition.rootThreadId).pipe(Effect.catch(warn("observe")));
      return deadlines.reconcilePendingRequests(
        { hostId: "local", conversationId: transition.rootThreadId },
        [],
      );
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* deadlines.timeouts.pipe(
    Stream.filter((timeout) => timeout.responseKind === "runtimeUserInput"),
    Stream.runForEach((timeout) =>
      Effect.gen(function* () {
        const lease = [...leases.values()].find(
          ({ fence }) =>
            fence.hostId === timeout.connection.hostId &&
            fence.generation === timeout.connection.generation,
        );
        if (!lease || typeof timeout.requestId !== "string") return;
        const snapshot = yield* lease.connection.request("thread.control", {
          threadId: timeout.conversationId,
          requestId: timeout.requestId,
        });
        if (leases.get(lease.connection.identity) !== lease) return;
        const request = snapshot.projection.runtimeRequests.find(
          (request) => request.id === timeout.requestId && isNonblockingLiveQuestion(request),
        );
        if (!request) return;
        yield* lease.connection.request("command.dispatch", {
          command: {
            type: "runtime-request.respond",
            commandId: `auto-user-input:${request.id}`,
            threadId: timeout.conversationId,
            requestId: request.id,
            answers: {},
          },
        });
      }).pipe(Effect.catch(warn("resolve"))),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const attach = Effect.fn("AgentRuntimeUserInputAutoResolution.attach")(function* (
    connection: AgentRuntimeProcessConnection,
  ) {
    const lease: RuntimeLease = {
      connection,
      fence: {
        hostId: `agent-runtime:${connection.identity.runtimeId}`,
        generation: ++nextGeneration,
      },
    };
    leases.set(connection.identity, lease);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (leases.get(connection.identity) === lease) leases.delete(connection.identity);
        yield* deadlines.handleDisconnect(lease.fence.hostId, lease.fence.generation);
      }),
    );
    // Activity transitions exclude the initial recovery snapshot. Recover pending deadlines
    // once per generation without creating a second execution subscription or starting a Runtime.
    let cursor: string | undefined;
    do {
      const page = yield* connection.request("execution.activity", {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const root of page.items)
        if (root.pendingRequestCount > 0) yield* reconcile(lease, root.rootThreadId);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  });
  return { attach };
});
