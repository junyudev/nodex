import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import type { CoreModules } from "../core-runtime/CoreModules";
import { rankedChatPage, unreadChats } from "./catalog";

test("chat search continuations preserve rank and reject a different search or missing anchor", () => {
  const ranked = ["third", "first", "second"];
  const page = rankedChatPage(ranked, "query", undefined, 2);
  expect(page?.sessionIds).toEqual(["third", "first"]);
  expect(rankedChatPage(ranked, "query", page?.nextCursor, 2)).toEqual({
    sessionIds: ["second"],
    nextCursor: null,
  });
  expect(rankedChatPage(ranked, "another query", page?.nextCursor, 2)).toBeNull();
  expect(rankedChatPage(["second", "third"], "query", page?.nextCursor, 2)).toBeNull();
});

it.effect("answers which asked-about chats the chat list still shows as unread", () =>
  Effect.gen(function* () {
    const reads: unknown[] = [];
    const core = {
      workspace: {
        read: (input: unknown) => {
          reads.push(input);
          return Effect.succeed({
            value: {
              kind: "session_window",
              sessions: {
                items: [
                  { task: { session: { id: "unread", unread: true } } },
                  { task: { session: { id: "read", unread: false } } },
                ],
              },
            },
          });
        },
      },
    } as unknown as CoreModules["Service"];
    const unread = unreadChats(core);
    // An archived or hidden chat is absent from the chat list, so it is not unread either.
    expect(yield* unread({ sessionIds: ["unread", "read", "archived", "unread"] })).toEqual({
      sessionIds: ["unread"],
    });
    expect(reads).toEqual([
      {
        kind: "session_window",
        archived: false,
        order: "identity",
        session_ids: ["unread", "read", "archived"],
        window: { first: 100 },
      },
    ]);
    expect(yield* unread({ sessionIds: [] })).toEqual({ sessionIds: [] });
    expect(reads).toHaveLength(1);
  }),
);
