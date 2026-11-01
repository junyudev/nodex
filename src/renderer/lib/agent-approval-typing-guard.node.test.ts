import { describe, expect, test } from "vite-plus/test";
import {
  initialAgentApprovalTypingGuard,
  reduceAgentApprovalTypingGuard as reduce,
} from "./agent-approval-typing-guard";

describe("approval typing guard", () => {
  test.each([1499, 1500, 1501])(
    "holds only arrivals before the 1500 ms idle boundary: %s",
    (elapsed) => {
      let state = reduce(initialAgentApprovalTypingGuard(), { type: "focus" });
      state = reduce(state, { type: "type", now: 100 });
      state = reduce(state, { type: "requests", ids: ["a"], now: 100 + elapsed });
      expect(state.held.has("a")).toBe(elapsed < 1500);
      expect(state.seen.has("a")).toBe(true);
    },
  );
  test("never holds an existing request again and drops removed held requests", () => {
    let state = reduce(initialAgentApprovalTypingGuard(), {
      type: "requests",
      ids: ["old"],
      now: 0,
    });
    state = reduce(reduce(state, { type: "focus" }), { type: "type", now: 10 });
    state = reduce(state, { type: "requests", ids: ["old", "new"], now: 11 });
    expect([...state.held]).toEqual(["new"]);
    state = reduce(state, { type: "requests", ids: ["old"], now: 12 });
    expect(state.held.size).toBe(0);
    expect([...reduce(state, { type: "requests", ids: ["new"], now: 13 }).held]).toEqual([]);
  });
  test.each(["blur", "send", "idle"] as const)("%s releases holds and resets typing", (type) => {
    let state = reduce(initialAgentApprovalTypingGuard(), { type: "focus" });
    state = reduce(state, { type: "type", now: 100 });
    state = reduce(state, { type: "requests", ids: ["a"], now: 101 });
    state = reduce(state, { type });
    expect(state.held.size).toBe(0);
    expect(state.lastTypedAt).toBe(-Infinity);
    expect(state.focused).toBe(type !== "blur");
  });
  test("unfocused typing never holds a new request", () => {
    const state = reduce(initialAgentApprovalTypingGuard(), { type: "type", now: 100 });
    expect(reduce(state, { type: "requests", ids: ["a"], now: 101 }).held.size).toBe(0);
  });
});
