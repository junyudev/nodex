import { describe, expect, test } from "bun:test";
import { resolveThreadCardResult, resolveThreadCardStatus } from "./thread-card-fetch";

const CARD = {
  id: "card-1",
  status: "in_progress",
  archived: false,
  title: "Thread card",
  description: "",
  priority: "p2-medium",
  tags: [],
  agentBlocked: false,
  created: new Date("2026-03-12T00:00:00.000Z"),
  order: 0,
};

describe("thread card fetch helpers", () => {
  test("accepts the current card:get payload shape", () => {
    expect(resolveThreadCardResult(CARD)?.id).toBe("card-1");
    expect(resolveThreadCardStatus(CARD)).toBe("in_progress");
  });

  test("rejects the removed wrapped payload shape", () => {
    expect(resolveThreadCardResult({ card: CARD, columnId: "in_progress" })).toBe(null);
    expect(resolveThreadCardStatus({ card: CARD, columnId: "in_progress" })).toBe(null);
  });
});
