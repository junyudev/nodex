import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { createUuidV7 } from "../../shared/uuid-v7";
import * as Stream from "effect/Stream";
import { resolveInboxModel } from "../inbox-application/InboxRuntimeSelection";

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const authority = yield* CoreAuthority;
  const runtime = yield* AgentRuntimeApplication;
  const settings = yield* ApplicationSettings;
  const lane = yield* Semaphore.make(1);
  const notifier = yield* DatabaseNotifierRuntime;
  // Workspace invalidations discard the cached Core-backed identity.
  let cached: { readonly sessionId: string | null } | null = null;
  yield* notifier.projectSessionInvalidations.pipe(
    Stream.runForEach(() =>
      Effect.sync(() => {
        cached = null;
      }),
    ),
    Effect.forkScoped,
  );
  const read = Effect.fn("CoordinatorSession.read")(function* () {
    const snapshot = yield* core.workspace.read({ kind: "read_coordinator" }, undefined, null);
    if (snapshot.value.kind !== "read_coordinator")
      return yield* Effect.die("Invalid Coordinator read");
    cached = { sessionId: snapshot.value.session_id ?? null };
    return cached.sessionId;
  });
    Effect.gen(function* () {
      const bound = yield* read();
      let recovering: components["schemas"]["ProjectWorkspaceAgentRuntimeSessionBinding"] | null =
        null;
      if (bound) {
        const current = yield* core.workspace.read(
          { kind: "session", session_id: bound },
          undefined,
          null,
        );
        if (
          current.value.kind === "session" &&
          current.value.session &&
          !current.value.session.archived
        ) {
          const result = yield* core.workspace.read(
            { kind: "agent_runtime_session_binding", session_id: bound },
            undefined,
            null,
          );
          if (result.value.kind !== "agent_runtime_session_binding" || !result.value.binding)
            return yield* Effect.die("Coordinator execution binding is missing");
          const binding = result.value.binding;
          const metadata = yield* runtime.sessionMetadata({
            runtimeId: binding.runtime_id,
            threadIds: [binding.runtime_thread_id],
          });
          if (metadata.length > 0) return bound;
          // Resume the reserved launch with the configured model; generic root repair uses chat defaults.
          recovering = binding;
        } else {
          yield* core.workspace.apply(
            {
              operationId: `coordinator:retire:${createUuidV7()}`,
              intent: { kind: "unbind_coordinator", session_id: bound },
            },
            undefined,
            null,
          );
        }
      }
      const sessionId = recovering?.session_id ?? createUuidV7();
      const launchId =
        recovering?.launch_request_id ??
        `nodex:coordinator:${createHash("sha256").update(`${authority.identity.profileId}:${sessionId}`).digest("hex")}`;
      const selection = yield* resolveInboxModel(
        runtime,
        (yield* settings.snapshot()).inbox.suggestionAgent,
        "suggestion",
      );
      yield* runtime.launch({
        launchId,
        sessionId,
        acceptedAt: recovering
          ? DateTime.toEpochMillis(DateTime.makeUnsafe(recovering.bound_at))
          : yield* Clock.currentTimeMillis,
        projectId: null,
        title: "Nodex",
        modelSelection: selection,
        interactionMode: "default",
        messageOrigin: "host",
        coordinator: true,
        message: {
          messageId: `coordinator:ready:${sessionId}`,
          text: "Nodex is ready.",
          agentConfigs: [],
        },
      });
      yield* read();
      return sessionId;
    }),
  );
  const reset = () =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        const sessionId = yield* read();
        if (!sessionId) return;
        yield* runtime.archiveSession({
          operationId: `coordinator:archive:${createUuidV7()}`,
          payload: { sessionId },
        });
        yield* core.workspace.apply(
          {
            operationId: `coordinator:reset:${createUuidV7()}`,
            intent: { kind: "unbind_coordinator", session_id: sessionId },
          },
          undefined,
          null,
        );
        cached = null;
      }),
    );
  const isCoordinator = Effect.fn("CoordinatorSession.isCoordinator")(function* (
    sessionId: string,
  ) {
    // Core's bounded identity read is the authority, including across Profile restores.
    const current = cached ? cached.sessionId : yield* read();
    return current === sessionId;
  });
});
export class CoordinatorSession extends Context.Service<
  CoordinatorSession,
  Effect.Success<typeof make>
>()("nodex/CoordinatorSession") {}
export const live = Layer.effect(CoordinatorSession, make);
