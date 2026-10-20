import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../core-runtime/CoreModules";
import { decodeThreadHistoryCursor } from "@nodex/agent-runtime/orchestration/threadHistoryPaging";
import { make } from "./RuntimeSessionObservation";
const provenance = {
  profile_id: "profile",
  authority: { actor_project_id: "project" },
} as never;
const fixture = () => {
  const calls: string[] = [];
  let denied = false;
  const session = {
    id: "session",
    project_id: "project",
    display_title: "Task",
    archived: false,
    pinned: false,
    updated_at: "today",
    execution_ref: { runtime_id: "engine", thread_id: "root" },
  };
  const rows = [1, 2, 3, 4, 5].map((ordinal) => ({
    position: ordinal,
    sourceThreadId: "root",
    sourceItemId: `item:${ordinal}`,
    visibility: "local",
    item: {
      id: `item:${ordinal}`,
      threadId: "root",
      runId: `run:${ordinal}`,
      ordinal,
      type: "user_message",
      text: `Prompt ${ordinal}`,
    },
  }));
  const owner = make.pipe(
    Effect.provideService(CoreModules, {
      workspace: {
        read: (input: { kind: string }) => {
          calls.push(`core:${input.kind}`);
          if (denied) return Effect.fail(new Error("outside Project"));
          return Effect.succeed({ value: { kind: "agent_session", session, thread: null } });
        },
      },
    } as never),
    Effect.provideService(AgentRuntimeApplication, {
      inspect: () =>
        Effect.sync(() => {
          calls.push("inspect");
          return {
            threadId: "root",
            thread: {
              providerInstanceId: "codex",
              modelSelection: { instanceId: "codex", model: "gpt", options: [] },
              status: "completed",
              activeRunId: null,
              latestRunId: "run:5",
              pendingRuntimeRequest: null,
              updatedAt: "today",
            },
          };
        }),
      read: () =>
        Effect.sync(() => {
          calls.push("body");
          return {
            snapshot: {
              snapshotSequence: 5,
              historyCursor: null,
              hasMoreHistory: false,
              projection: { visibleTurnItems: rows },
            },
          };
        }),
      history: (input: { cursor: string }) =>
        Effect.sync(() => {
          calls.push("history");
          const anchor = decodeThreadHistoryCursor(input.cursor);
          return {
            snapshotSequence: 5,
            hasMoreHistory: false,
            nextCursor: null,
            items: rows.filter((row) => row.item.ordinal < anchor.so!),
          };
        }),
    } as never),
  );
  return {
    owner,
    calls,
    deny: () => {
      denied = true;
    },
  };
};
it.effect(
  "metadata inspection performs no transcript read and Core denies foreign Session before engine access",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const owner = yield* f.owner;
      const result = yield* owner.inspect("session", provenance);
      assert.equal(result.disposition, "complete");
      // The Agent its next message runs on, as send_message_to_session can change it.
      assert.deepEqual(result.agent, { providerInstanceId: "codex", model: "gpt" });
      assert.isFalse(f.calls.includes("body"));
      const before = f.calls.length;
      f.deny();
      assert.equal((yield* Effect.exit(owner.inspect("foreign", provenance)))._tag, "Failure");
      assert.deepEqual(f.calls.slice(before), ["core:agent_session"]);
    }),
);
it.effect(
  "bounded one-Turn reads preserve every omitted Turn through stable source-item cursors",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const owner = yield* f.owner;
      let cursor: string | undefined;
      const seen: string[] = [];
      for (let index = 0; index < 5; index++) {
        const result = yield* owner.read(
          {
            sessionId: "session",
            turnLimit: 1,
            includeOutputs: false,
            maxOutputCharsPerItem: 300,
            ...(cursor ? { cursor } : {}),
          },
          provenance,
        );
        assert.equal(result.history.availability, "available");
        if (result.history.availability !== "available") return;
        assert.lengthOf(result.history.turns, 1);
        seen.push(result.history.turns[0]!.turnId as string);
        cursor = result.history.page.nextCursor ?? undefined;
      }
      assert.deepEqual(seen, ["run:5", "run:4", "run:3", "run:2", "run:1"]);
      assert.isUndefined(cursor);
      assert.equal(f.calls.filter((call) => call === "body").length, 1);
    }),
);
