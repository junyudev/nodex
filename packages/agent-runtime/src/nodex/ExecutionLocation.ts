import { CommandId, ThreadId, type ProviderSessionId, type RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreV2,
  type ProjectionExecutionActorPage,
} from "../orchestration-v2/ProjectionStore.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import type { AgentExecutionLocation } from "./Interface.ts";
import { CODEX_THREAD_IMPORT_OPERATION_PREFIX } from "./CodexImportLimits.ts";

const fail = (message: string) => Effect.fail(new Error(message));
const identity = (operationId: string, ...parts: string[]) =>
  CommandId.make(
    `host:workspace:${createHash("sha256")
      .update(JSON.stringify([operationId, ...parts]))
      .digest("base64url")}`,
  );

/** Journal-owned workspace transactions use the ordinary command writer and outbox. */
export const make = Effect.gen(function* () {
  const store = yield* ProjectionStoreV2;
  const writer = yield* OrchestratorV2;
  const outbox = yield* EffectOutboxV2;
  const root = Effect.fnUntraced(function* (threadId: string, operationId?: string) {
    const thread = yield* store.getThread(ThreadId.make(threadId));
    if (thread.executionHandoff?.operationId.startsWith(CODEX_THREAD_IMPORT_OPERATION_PREFIX))
      return yield* fail(
        "The conversation's Codex import must finish before changing its execution directory",
      );
    if (thread.id !== thread.lineage.rootThreadId || thread.deletedAt !== null)
      return yield* fail("A live Session execution root is required");
    if (operationId !== undefined && thread.executionHandoff?.operationId !== operationId)
      return yield* fail("The execution location transaction is no longer current");
    return thread;
  });
  const waitEffect = Effect.fnUntraced(function* (effectId: string) {
    yield* Effect.gen(function* () {
      const effect = yield* outbox.get(effectId);
      if (Option.isNone(effect)) return yield* fail("The provider detach receipt is unavailable");
      if (effect.value.status === "failed" || effect.value.status === "cancelled")
        return yield* fail("The provider source did not detach");
      return effect.value.status === "succeeded";
    }).pipe(
      Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("25 millis") }),
      Effect.timeout("10 seconds"),
    );
  });
  return {
    hold: Effect.fn("ExecutionLocation.hold")(function* (input: {
      readonly threadId: string;
      readonly operationId: string;
      readonly action: "acquire" | "recovery" | "release";
      readonly recoveryRequired?: boolean | undefined;
      readonly sourceLocation?: AgentExecutionLocation | undefined;
    }) {
      const thread = yield* root(input.threadId);
      const previous = thread.executionHandoff;
      if (previous && previous.operationId !== input.operationId)
        return yield* fail("Another workspace transaction owns this Session");
      if (input.action === "release" && previous?.recoveryRequired)
        return yield* fail("The workspace transaction still requires recovery");
      if (input.action === "release" && !previous) return null;
      if (
        input.action === "release" &&
        (yield* store.getExecutionDetachBarrier(thread.id)) !== null
      )
        return yield* fail("The old provider source has not acknowledged retirement");
      if (input.action === "release") {
        let cursor: string | undefined;
        do {
          const page = yield* store.getExecutionActors(thread.id, cursor);
          if (
            page.items.some(
              (actor) => actor.activeRunId !== null || actor.providerSessionId !== null,
            )
          )
            return yield* fail(
              "The original execution sources still require retirement settlement",
            );
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
      }
      if (input.action === "acquire" && previous) return null;
      if (!previous && input.action === "recovery" && input.recoveryRequired === false) return null;
      if (!previous && (!input.sourceLocation || input.sourceLocation.cwd !== thread.worktreePath))
        return yield* fail("The source workspace changed before handoff admission");
      const next =
        input.action === "release"
          ? null
          : {
              operationId: input.operationId,
              recoveryRequired:
                input.action === "recovery"
                  ? input.recoveryRequired === true
                  : (previous?.recoveryRequired ?? false),
              ...(previous?.sourceLocation || input.sourceLocation
                ? { sourceLocation: previous?.sourceLocation ?? input.sourceLocation! }
                : {}),
            };
      yield* writer.dispatch({
        type: "thread.metadata.update",
        threadId: thread.id,
        commandId: identity(input.operationId, "hold", randomUUID()),
        expectedExecutionHandoffId: previous?.operationId ?? null,
        expectedWorktreePath: thread.worktreePath,
        executionHandoff: next,
      });
      if (input.action === "release") {
        let cursor: string | undefined;
        do {
          const page = yield* store.getExecutionActors(thread.id, cursor);
          for (const actor of page.items) yield* writer.resumeThreadQueue(actor.threadId);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
      }
      return null;
    }),
    quiesce: Effect.fn("ExecutionLocation.quiesce")(function* (input: {
      readonly threadId: string;
      readonly operationId: string;
    }) {
      yield* root(input.threadId, input.operationId);
      // An explicit recovery attempt may retry the same replay-safe retirement once.
      // A failure during this attempt stays failed until another explicit call.
      const previousBarrier = yield* store.getExecutionDetachBarrier(ThreadId.make(input.threadId));
      if (previousBarrier !== null) {
        const previous = yield* outbox.get(previousBarrier);
        if (
          Option.isSome(previous) &&
          (previous.value.status === "failed" || previous.value.status === "cancelled")
        )
          yield* outbox.retryReplaySafe({
            effectId: previousBarrier,
            effectType: "provider-session.detach",
            expectedStatus: previous.value.status,
          });
      }
      let previousRetirement = previousBarrier;
      while (previousRetirement !== null) {
        yield* waitEffect(previousRetirement);
        previousRetirement = yield* store.getExecutionDetachBarrier(ThreadId.make(input.threadId));
      }
      const retire = Effect.fnUntraced(function* (actor: {
        readonly threadId: ThreadId;
        readonly providerSessionId: ProviderSessionId | null;
        readonly activeRunId?: RunId | null;
      }) {
        const commandId = actor.providerSessionId
          ? identity(input.operationId, "detach", actor.threadId, actor.providerSessionId)
          : null;
        if (commandId && actor.providerSessionId) {
          yield* writer.dispatch({
            type: "provider-session.detach",
            threadId: actor.threadId,
            providerSessionId: actor.providerSessionId,
            commandId,
            revokeMcpCredential: true,
            ...(actor.activeRunId ? { retirementRunId: actor.activeRunId } : {}),
            reason: "Execution workspace moving",
          });
          const effectId = `effect:${commandId}:provider-session.detach:${actor.providerSessionId}`;
          yield* waitEffect(effectId);
          return effectId;
        }
        return null;
      });
      // Retire every binding before settling any run: one thread can have several
      // native sources, and its transaction proof requires all of them to be gone.
      let cursor: string | undefined;
      do {
        const page: ProjectionExecutionActorPage = yield* store.getExecutionActors(
          ThreadId.make(input.threadId),
          cursor,
        );
        for (const actor of page.items) yield* retire(actor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      let settledAny: boolean;
      do {
        settledAny = false;
        cursor = undefined;
        do {
          const page: ProjectionExecutionActorPage = yield* store.getExecutionActors(
            ThreadId.make(input.threadId),
            cursor,
          );
          for (const actor of page.items) {
            const effectId = yield* retire(actor);
            if (!actor.activeRunId) continue;
            yield* writer.dispatch({
              type: "run.interrupt",
              threadId: actor.threadId,
              runId: actor.activeRunId,
              holdQueue: false,
              sourceRetirement: { operationId: input.operationId, effectId },
              commandId: identity(
                input.operationId,
                "interrupt",
                actor.threadId,
                actor.activeRunId,
              ),
            });
            settledAny = true;
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
      } while (settledAny);
      // A retry or restart can observe the detached metadata before the old physical
      // source exits. Outstanding durable cleanup remains a barrier even without a binding.
      let barrier = yield* store.getExecutionDetachBarrier(ThreadId.make(input.threadId));
      while (barrier !== null) {
        yield* waitEffect(barrier);
        barrier = yield* store.getExecutionDetachBarrier(ThreadId.make(input.threadId));
      }
      yield* root(input.threadId, input.operationId);
      return null;
    }),
    commit: Effect.fn("ExecutionLocation.commit")(function* (input: {
      readonly threadId: string;
      readonly operationId: string;
      readonly location: AgentExecutionLocation;
      readonly sourceWorkspaceRoot?: string | undefined;
      readonly childrenOnly?: boolean | undefined;
    }) {
      const thread = yield* root(input.threadId, input.operationId);
      if (
        input.location.hostId !== "local" ||
        !path.isAbsolute(input.location.cwd) ||
        input.location.workspaceRoots.some((root) => !path.isAbsolute(root))
      )
        return yield* fail("Runtime workspace relocation requires an absolute local destination");
      if ((yield* store.getExecutionDetachBarrier(thread.id)) !== null)
        return yield* fail("The old provider source has not acknowledged retirement");
      const sourcePrimary =
        input.sourceWorkspaceRoot ?? thread.executionHandoff?.sourceLocation?.workspaceRoots[0];
      const targetPrimary = input.location.workspaceRoots[0];
      // Descendants sharing the moved workspace follow its physical location; independent
      // workspaces stay attached. Root commits last so journal recovery observes one boundary.
      let cursor: string | undefined;
      do {
        const page = yield* store.getExecutionActors(thread.id, cursor);
        for (const actor of page.items) {
          if (actor.activeRunId || actor.providerSessionId)
            return yield* fail("Execution must stop before committing its workspace");
          if (actor.threadId === thread.id || !sourcePrimary || !targetPrimary) continue;
          const child = yield* store.getThread(actor.threadId);
          if (!child.worktreePath) continue;
          if (child.executionLocation?.workspaceRoots[0] === targetPrimary) continue;
          const relative = path.relative(sourcePrimary, child.worktreePath);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            continue;
          const cwd = path.join(targetPrimary, relative);
          if (cwd === child.worktreePath) continue;
          yield* writer.dispatch({
            type: "thread.metadata.update",
            threadId: child.id,
            commandId: identity(input.operationId, "child-location", child.id, cwd),
            expectedWorktreePath: child.worktreePath,
            worktreePath: cwd,
            executionLocation: { ...input.location, cwd },
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      if (input.childrenOnly) return null;
      yield* writer.dispatch({
        type: "thread.metadata.update",
        threadId: thread.id,
        commandId: identity(input.operationId, "location", input.location.cwd),
        expectedExecutionHandoffId: input.operationId,
        expectedWorktreePath: thread.worktreePath,
        worktreePath: input.location.cwd,
        executionLocation: input.location,
        branch: null,
      });
      return null;
    }),
  };
});
