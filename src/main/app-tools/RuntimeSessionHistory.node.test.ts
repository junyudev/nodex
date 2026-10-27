import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { runtimeSessionHistory } from "./RuntimeSessionHistory";

it.effect(
  "continues Runtime windows by exact source identity and reports a removed anchor as stale",
  () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      let missing = false;
      const source = runtimeSessionHistory(
        {
          timeline: (input: unknown) =>
            Effect.sync(() => {
              calls.push(input);
              if (missing) return { items: [], totalItems: 1, hasMore: false, anchorFound: false };
              return {
                items: [
                  {
                    sourceThreadId: "captured:parent",
                    sourceItemId: "item:selected",
                    position: 7,
                    visibility: "inherited",
                    item: {
                      id: "item:selected",
                      runId: "run:selected",
                      type: "assistant_message",
                      status: "completed",
                      updatedAt: "2026-10-27T00:00:00.000Z",
                    },
                  },
                ],
                totalItems: 9,
                hasMore: true,
                anchorFound: true,
              };
            }),
        } as unknown as AgentRuntimeApplication["Service"],
        "session:a",
      );
      const first = yield* source.page({
        order: "newest_first",
        view: "messages",
        maxCharsPerItem: 8000,
        limit: 1,
      });
      assert.deepEqual(first.items[0]?.reference, {
        itemId: "item:selected",
        sourceThreadId: "captured:parent",
        runId: "run:selected",
        type: "assistant_message",
        status: "completed",
        visibility: "inherited",
        updatedAt: "2026-10-27T00:00:00.000Z",
      });
      yield* source.page({
        order: "newest_first",
        view: "messages",
        maxCharsPerItem: 8000,
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.deepEqual(calls[1], {
        sessionId: "session:a",
        view: "messages",
        order: "newest_first",
        limit: 1,
        beforeItem: { sourceThreadId: "captured:parent", sourceItemId: "item:selected" },
      });
      const forward = yield* source.page({
        order: "oldest_first",
        view: "messages",
        maxCharsPerItem: 8000,
        limit: 1,
        cursor: first.tailCursor!,
      });
      assert.isNotNull(forward.tailCursor);
      assert.deepEqual(calls[2], {
        sessionId: "session:a",
        view: "messages",
        order: "oldest_first",
        limit: 1,
        afterItem: { sourceThreadId: "captured:parent", sourceItemId: "item:selected" },
      });
      missing = true;
      const stale = yield* source
        .page({
          order: "newest_first",
          view: "messages",
          maxCharsPerItem: 8000,
          limit: 1,
          cursor: first.nextCursor!,
        })
        .pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure") assert.equal(stale.failure.reason, "cursor_stale");
      const invalid = yield* source
        .page({
          order: "newest_first",
          view: "messages",
          maxCharsPerItem: 8000,
          limit: 1,
          cursor: "7",
        })
        .pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      if (invalid._tag === "Failure") assert.equal(invalid.failure.reason, "invalid_cursor");
    }),
);
