import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeSessionActivityChange } from "../../shared/agent-runtime-api";
import type { PushPayload } from "@nodex/mobile-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { CoreModules } from "../core-runtime/CoreModules";
import { snapshotTurnItems } from "./transcript-projection";

export interface MobilePushEvent {
  readonly id: string;
  readonly payload: PushPayload;
}

export class MobilePushEvents extends Context.Service<
  MobilePushEvents,
  {
    readonly events: Stream.Stream<MobilePushEvent>;
  }
>()("nodex/main/mobile-gateway/MobilePushEvents") {}

/** Uses the same Session activity and conversation window as the phone's chat list. */
export const makeMobilePushEvents = Effect.gen(function* () {
  const activity = yield* AgentRuntimeSessionActivity;
  const runtime = yield* AgentRuntimeApplication;
  const core = yield* CoreModules;

  const events = Stream.callback<MobilePushEvent>((queue) =>
    Effect.gen(function* () {
      const knownRequests = new Set<string>();
      const knownRuns = new Set<string>();
      const activeRuns = new Map<string, string>();
      // Subscribe before reading the baseline, so a change during those reads is not lost.
      const changes = yield* Queue.bounded<AgentRuntimeSessionActivityChange>(128);
      yield* activity.activityChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const read = (sessionId: string, runId?: string) =>
        runtime.control({ sessionId, ...(runId ? { runId } : {}) });
      const remember = (sessionId: string, snapshot: AgentSnapshot) => {
        for (const request of snapshot.projection.runtimeRequests)
          knownRequests.add(`${sessionId}:${request.id}`);
      };
      const baseline = Effect.gen(function* () {
        const current = yield* activity.read;
        activeRuns.clear();
        for (const item of current.items) {
          if (item.activeRunId) activeRuns.set(item.sessionId, item.activeRunId);
          yield* read(item.sessionId).pipe(
            Effect.tap(({ snapshot }) => Effect.sync(() => remember(item.sessionId, snapshot))),
            Effect.ignore,
          );
        }
        return current.sequence;
      });
      let floor = yield* baseline;
      const observe = (sessionId: string, nextRunId: string | null) =>
        Effect.gen(function* () {
          const previousRunId = activeRuns.get(sessionId);
          if (nextRunId) activeRuns.set(sessionId, nextRunId);
          else activeRuns.delete(sessionId);
          // Core applies the chat list's root, side-chat, Project and archive visibility rules.
          const page = yield* core.workspace.read({
            kind: "session_window",
            archived: false,
            order: "conversation",
            session_ids: [sessionId],
            window: { first: 1 },
          });
          if (page.value.kind !== "session_window" || !page.value.sessions.items.length) return;
          const row = page.value.sessions.items[0]!;
          const title = row.task.session.display_title;
          const { snapshot } = yield* runtime.read({ sessionId });
          const pending = new Set(
            snapshot.projection.runtimeRequests
              .filter(
                (request) =>
                  request.status === "pending" && request.responseCapability.type === "live",
              )
              .map((request) => request.id),
          );
          for (const item of snapshotTurnItems(snapshot.projection)) {
            if (item.type !== "approval_request" && item.type !== "user_input_request") continue;
            const id = `${sessionId}:${item.requestId}`;
            if (!pending.has(item.requestId) || knownRequests.has(id)) continue;
            knownRequests.add(id);
            const body =
              item.type === "approval_request"
                ? (item.title ?? "Approval requested")
                : item.questions.some((question) => question.isSecret)
                  ? "Answer on your desktop"
                  : (item.questions[0]?.question ?? "Answer requested");
            yield* Queue.offer(queue, {
              id: `request:${id}`,
              payload: { kind: "needs_you", sessionId, title, body },
            });
          }
          if (!previousRunId || previousRunId === nextRunId) return;
          const id = `${sessionId}:${previousRunId}`;
          if (knownRuns.has(id)) return;
          knownRuns.add(id);
          const ended = yield* read(sessionId, previousRunId);
          const run = ended.snapshot.projection.runs.find((run) => run.id === previousRunId);
          if (!run || (run.status !== "completed" && run.status !== "failed")) return;
          const outcome =
            run.status === "completed"
              ? yield* runtime
                  .runOutcome({ sessionId, messageId: run.userMessageId })
                  .pipe(Effect.orElseSucceed(() => null))
              : null;
          const final =
            outcome?.runId === previousRunId && outcome.finalAssistantItemId
              ? yield* runtime
                  .item({ sessionId, itemId: outcome.finalAssistantItemId })
                  .pipe(Effect.orElseSucceed(() => null))
              : null;
          yield* Queue.offer(queue, {
            id: `run:${id}`,
            payload: {
              kind: run.status === "failed" ? "failed" : "finished",
              sessionId,
              title,
              body:
                run.status === "failed"
                  ? "Run failed"
                  : final?.type === "assistant_message"
                    ? final.text.trim() || "Finished"
                    : "Finished",
            },
          });
        });
      yield* Stream.fromQueue(changes).pipe(
        Stream.runForEach((change) =>
          Effect.gen(function* () {
            if (change.sequence <= floor) return;
            if (change.type === "reset" || change.sequence !== floor + 1) {
              floor = yield* baseline;
              return;
            }
            floor = change.sequence;
            const sessionId =
              change.type === "upsert" ? change.activity.sessionId : change.sessionId;
            const next = change.type === "upsert" ? change.activity.activeRunId : null;
            yield* observe(sessionId, next).pipe(
              Effect.catchCause(() =>
                Effect.logWarning("Mobile notification event could not be read"),
              ),
            );
          }),
        ),
      );
    }),
  );
  return MobilePushEvents.of({ events });
});
