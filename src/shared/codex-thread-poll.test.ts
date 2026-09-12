import { expect, test } from "vite-plus/test";
import { ThreadPollCache, pollWake, unchangedTerminalPoll } from "./codex-thread-poll";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
const target = { hostId: "local", threadId: "thread" };
const turn = (status: Turn["status"] = "completed", text = "final"): Turn => ({ id: "turn", status, error: null, itemsView: "full", startedAt: 1, completedAt: 2, durationMs: 1000, items: [{ type: "agentMessage", id: "message", text, phase: "final_answer", memoryCitation: null, delivery: null, questions: null }] });
test("cursor omits unchanged final text and suppresses repeated completion wakes", () => {
  const cache = new ThreadPollCache(() => "generation");
  const initial = cache.commit(target, { type: "idle" }, turn(), cache.beginRead());
  expect(pollWake(initial)).toEqual({ reason: "turnCompleted", turnId: "turn" });
  const repeated = cache.commit({ ...target, afterCursor: initial.cursor }, { type: "idle" }, turn(), cache.beginRead());
  expect(repeated.changed).toBe(false); expect(repeated.latestAssistantMessage).toBeNull(); expect(repeated.latestAssistantMessageId).toBe("message");
  expect(pollWake(repeated)).toBeNull(); expect(unchangedTerminalPoll(repeated)).toBe(true);
  expect(cache.withProgress(repeated).latestAssistantMessage?.text).toBe("final");
});
test("late native reads cannot regress completed turns or longer streaming text", () => {
  const cache = new ThreadPollCache(() => "generation");
  const early = cache.beginRead();
  cache.commit(target, { type: "active", activeFlags: [] }, turn("inProgress", "long text"), cache.beginRead());
  expect(cache.commit(target, { type: "active", activeFlags: [] }, turn("inProgress", "long"), cache.beginRead()).latestAssistantMessage?.text).toBe("long text");
  cache.commit(target, { type: "idle" }, turn(), cache.beginRead());
  expect(cache.commit(target, { type: "active", activeFlags: [] }, turn("inProgress"), early).thread.status.type).toBe("idle");
  expect(cache.commit(target, { type: "idle" }, turn("inProgress"), cache.beginRead()).latestTurn?.status).toBe("completed");
});
test("unknown and future cursors reset independently for each host", () => {
  const cache = new ThreadPollCache(() => "generation");
  expect(cache.commit({ ...target, afterCursor: "old:1" }, { type: "idle" }, turn(), cache.beginRead()).cursorReset).toBe(true);
  expect(cache.commit({ ...target, afterCursor: "generation:999" }, { type: "idle" }, turn(), cache.beginRead()).cursorReset).toBe(true);
  expect(cache.commit({ ...target, hostId: "remote" }, { type: "idle" }, turn(), cache.beginRead()).revision).toBe(1);
});

test("completion fallback preserves cached output even when the notification labels empty items as full", () => {
  const cache = new ThreadPollCache(() => "generation");
  cache.commit(target, { type: "active", activeFlags: [] }, turn("inProgress", "visible progress"), cache.beginRead());
  const completed = { ...turn(), items: [] };
  const result = cache.fallback(target, completed, null);
  expect(result?.latestTurn?.status).toBe("completed");
  expect(result?.latestAssistantMessage?.text).toBe("visible progress");
  expect(result?.thread.status.type).toBe("idle");
});
