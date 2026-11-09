import { expect, test } from "vitest";
import { parsePageTurn, type PageTurn } from "./page-turn";

test("preserves the selected pause authority through the shared Turn boundary", () => {
  const turn: PageTurn = {
    page_id: "page",
    actor: { kind: "member", member_id: "member" },
    reason: "paused",
    since: "today",
    episode: "episode",
    hold: {
      scope: { kind: "project", project_id: "project" },
      actor: "member",
      revision: 4,
      paused_at: "today",
    },
  };
  expect(parsePageTurn(turn)).toEqual(turn);
  expect(() =>
    parsePageTurn({ ...turn, hold: { ...turn.hold, scope: { kind: "project" } } }),
  ).toThrow();
});
