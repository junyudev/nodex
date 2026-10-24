import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";

import * as CodexErrors from "effect-codex-app-server/errors";
import { revertCodexThread, revertCodexThreadTurns } from "./CodexThreadRevert.ts";

const page = (
  id: number,
  cursor: string | null,
  limit: number,
  turns: string[],
  nextCursor: string | null,
) => [
  {
    type: "expect_outbound" as const,
    frame: {
      id,
      method: "thread/turns/list",
      params: {
        threadId: "thread",
        cursor,
        limit,
        sortDirection: "desc",
        itemsView: "summary",
      },
    },
  },
  {
    type: "emit_inbound" as const,
    frame: {
      id,
      result: {
        data: turns.map((id) => ({ id, items: [], status: "completed", error: null })),
        nextCursor,
      },
    },
  },
];

it.effect("finds the revert boundary across pages of newest-first turns", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    // The final request reaches the server with the third-newest turn, not a turn on the first page.
    assert.equal(result.message, "boundary reached");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-pages",
        entries: [
          ...page(1, null, 3, ["newest", "middle"], "older"),
          ...page(2, "older", 1, ["boundary"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 3,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "boundary" },
            },
          },
          {
            type: "emit_inbound",
            frame: { id: 3, error: { code: -32603, message: "boundary reached" } },
          },
        ],
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("rejects repeated cursors instead of looping or reverting incomplete history", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    assert.equal(result.message, "Thread history pagination repeated a cursor.");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-loop",
        entries: [...page(1, null, 3, ["newest"], "again"), ...page(2, "again", 2, [], "again")],
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("reconciles a lost revert acknowledgement without removing retained Turns on retry", () =>
  Effect.gen(function* () {
    const retained = Array.from({ length: 202 }, (_, index) => `retained-${index}`);
    let history = ["discarded-last", "discarded-first", ...retained];
    const reverted: string[] = [];
    const requests: string[] = [];
    const limits: number[] = [];
    const client = {
      request: (
        method: string,
        params: { beforeTurnId?: string; cursor?: string | null; limit?: number },
      ) =>
        Effect.gen(function* () {
          requests.push(method);
          if (method === "thread/turns/list") {
            const start = Number(params.cursor ?? 0);
            const end = start + params.limit!;
            limits.push(params.limit!);
            return {
              data: history.slice(start, end).map((id) => ({ id })),
              nextCursor: end < history.length ? String(end) : null,
            };
          }
          if (method === "thread/read") return { thread: { id: "thread" } };
          assert.equal(method, "thread/revert");
          const boundary = params.beforeTurnId!;
          reverted.push(boundary);
          history = history.slice(history.indexOf(boundary) + 1);
          return yield* CodexErrors.CodexAppServerRequestError.internalError(
            "lost acknowledgement",
          );
        }),
    } as Pick<CodexClient.CodexAppServerClient["Service"], "request">;
    const discarded = ["discarded-first", "discarded-last"];
    const error = yield* revertCodexThreadTurns(client, "thread", discarded).pipe(Effect.flip);
    assert.equal(error.message, "lost acknowledgement");
    const result = yield* revertCodexThreadTurns(client, "thread", discarded);
    assert.equal(result.thread.id, "thread");
    assert.deepEqual(history, retained);
    assert.deepEqual(limits, [2, 2, 100, 100]);
    assert.deepEqual(reverted, ["discarded-first"]);
    assert.deepEqual(requests, [
      "thread/turns/list",
      "thread/revert",
      "thread/turns/list",
      "thread/turns/list",
      "thread/turns/list",
      "thread/read",
    ]);
  }),
);
