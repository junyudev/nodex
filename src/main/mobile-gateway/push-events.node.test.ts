import { it } from "@effect/vitest";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { expect } from "vitest";
import type {
  AgentRuntimeSessionActivity as Activity,
  AgentRuntimeSessionActivityChange,
} from "../../shared/agent-runtime-api";
import {
  agentRuntimeRow,
  agentRuntimeSnapshotFixture,
} from "../../shared/testing/agent-runtime-snapshot";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { CoreModules } from "../core-runtime/CoreModules";
import { makeMobilePushEvents, type MobilePushEvent } from "./push-events";

const turnItem = (item: Partial<AgentTurnItem>) => item as AgentTurnItem;
const question = (id: string, secret = false) =>
  turnItem({
    type: "user_input_request",
    requestId: id,
    questions: [
      {
        id: "q",
        question: "Which environment?",
        isSecret: secret,
        header: "Environment",
        options: [],
      },
    ],
  });
const approval = turnItem({
  type: "approval_request",
  requestId: "approval",
  title: "Run the migration?",
});
const activity = (runId: string | null): Activity => ({
  sessionId: "chat",
  threadId: "thread",
  status: "running",
  activeRunId: runId,
  pendingRequestCount: 0,
  backgroundTasks: [],
  providerInstanceId: "codex",
  model: "model",
  updatedAt: "2026-11-01T00:00:00Z",
});
const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true });

it.effect(
  "baselines existing requests, emits each new request and Run once, and excludes stopped and hidden work",
  () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<AgentRuntimeSessionActivityChange>();
      const received = yield* Queue.unbounded<MobilePushEvent>();
      let sequence = 0;
      let active: Activity[] = [activity("baseline-run")];
      let items = [question("existing")];
      let runStatus = "running";
      let runId = "baseline-run";
      let finalText: string | null = "Done, with details";
      const read = () =>
        Effect.succeed({
          snapshot: agentRuntimeSnapshotFixture({
            projection: {
              turnItems: items,
              runtimeRequests: items.map((item) =>
                agentRuntimeRow("runtimeRequests", {
                  id: "requestId" in item ? item.requestId : "",
                  status: "pending",
                  responseCapability: { type: "live", providerSessionId: "provider-session" },
                }),
              ),
              runs: [
                agentRuntimeRow("runs", {
                  id: runId,
                  userMessageId: "message",
                  status: runStatus as "running",
                }),
              ],
            },
          }),
        });
      const source = yield* makeMobilePushEvents.pipe(
        Effect.provideService(AgentRuntimeSessionActivity, {
          read: Effect.sync(() => ({ sequence, items: active, complete: true })),
          activityChanges: Stream.fromQueue(changes),
          connection: Effect.succeed({ status: "idle" as const }),
          connectionChanges: Stream.never,
        }),
        Effect.provideService(AgentRuntimeApplication, {
          control: () =>
            read().pipe(
              Effect.map(({ snapshot }) => ({
                snapshot: {
                  ...snapshot,
                  projection: { ...snapshot.projection, turnItems: [], visibleTurnItems: [] },
                },
              })),
            ),
          read,
          runOutcome: () =>
            Effect.succeed({ runId, finalAssistantItemId: finalText ? "final" : null }),
          item: () =>
            Effect.succeed(
              finalText ? turnItem({ type: "assistant_message", text: finalText }) : null,
            ),
        } as unknown as AgentRuntimeApplication["Service"]),
        Effect.provideService(CoreModules, {
          workspace: {
            read: (input: { session_ids: string[] }) =>
              Effect.succeed({
                value: {
                  kind: "session_window",
                  sessions: {
                    items:
                      input.session_ids[0] === "hidden"
                        ? []
                        : [{ task: { session: { display_title: "Deploy app" } } }],
                  },
                },
              }),
          },
        } as unknown as CoreModules["Service"]),
      );
      yield* source.events.pipe(
        Stream.runForEach((event) => Queue.offer(received, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* settle;
      expect(yield* Queue.size(received)).toBe(0);
      const change = (id = "chat") =>
        Effect.gen(function* () {
          sequence++;
          yield* Queue.offer(changes, {
            type: "upsert",
            sequence,
            activity: { ...activity(runId), sessionId: id },
          });
          yield* settle;
        });
      yield* change();
      expect(yield* Queue.size(received)).toBe(0);
      items = [...items, approval, question("question"), question("secret", true)];
      yield* change();
      const requests = yield* Queue.takeBetween(received, 3, 3);
      expect(requests.map((event) => event.payload)).toEqual([
        { kind: "needs_you", sessionId: "chat", title: "Deploy app", body: "Run the migration?" },
        { kind: "needs_you", sessionId: "chat", title: "Deploy app", body: "Which environment?" },
        {
          kind: "needs_you",
          sessionId: "chat",
          title: "Deploy app",
          body: "Answer on your desktop",
        },
      ]);
      yield* change();
      expect(yield* Queue.size(received)).toBe(0);
      const end = (status: string) =>
        Effect.gen(function* () {
          runStatus = status;
          sequence++;
          yield* Queue.offer(changes, { type: "remove", sequence, sessionId: "chat" });
          yield* settle;
        });
      items = [];
      yield* end("completed");
      expect((yield* Queue.take(received)).payload).toMatchObject({
        kind: "finished",
        body: "Done, with details",
      });
      yield* change();
      yield* end("completed");
      expect(yield* Queue.size(received)).toBe(0);
      runId = "failed-run";
      runStatus = "running";
      yield* change();
      yield* end("failed");
      expect((yield* Queue.take(received)).payload).toMatchObject({
        kind: "failed",
        body: "Run failed",
      });
      for (const status of ["interrupted", "cancelled"]) {
        runId = status;
        runStatus = "running";
        yield* change();
        yield* end(status);
        expect(yield* Queue.size(received)).toBe(0);
      }
      runId = "no-reply";
      runStatus = "running";
      finalText = null;
      yield* change();
      yield* end("completed");
      expect((yield* Queue.take(received)).payload.body).toBe("Finished");
      items = [question("hidden-request")];
      yield* change("hidden");
      expect(yield* Queue.size(received)).toBe(0);
      // A process restart or a missed activity window is a fresh baseline, never a replay.
      active = [activity("restarted")];
      items = [question("restored-request")];
      sequence++;
      yield* Queue.offer(changes, { type: "reset", sequence });
      yield* settle;
      runId = "restarted";
      yield* change();
      expect(yield* Queue.size(received)).toBe(0);
    }),
);
