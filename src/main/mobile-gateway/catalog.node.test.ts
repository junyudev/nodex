import { expect, test } from "vitest";
import { rankedChatPage } from "./catalog";

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
