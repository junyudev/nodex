import { expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeInspection } from "../../../shared/agent-runtime-api";
import { createChatMessageRevealStore, createOpenChatAtMessage } from "./chat-message-navigation";

const inspection = {
  sessionId: "chat",
  projectId: "project",
  threadId: "root",
} as AgentRuntimeInspection;
it("opens the chat with an exact message reveal, preserving the chat's Project", async () => {
  const openSession = vi.fn();
  const store = createChatMessageRevealStore();
  const open = createOpenChatAtMessage({
    inspect: async () => inspection,
    openSession,
    reveal: store.request,
  });
  expect(await open({ sessionId: "chat", messageId: "message" })).toBe(true);
  expect(openSession).toHaveBeenCalledWith({ id: "chat", projectId: "project" });
  const first = store.read()!;
  expect(first).toEqual({ sessionId: "chat", threadId: "root", messageId: "message" });
  await open({ sessionId: "chat", messageId: "newer" });
  store.consume(first);
  expect(store.read()?.messageId).toBe("newer");
  store.consume(store.read()!);
  expect(store.read()).toBeNull();
});
it("ignores a missing chat and superseded asynchronous navigation", async () => {
  let resolve!: (value: AgentRuntimeInspection) => void;
  const inspect = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockRejectedValueOnce(new Error("Deleted"));
  const openSession = vi.fn();
  const open = createOpenChatAtMessage({ inspect, openSession, reveal: vi.fn() });
  const old = open({ sessionId: "old", messageId: "message" });
  expect(await open({ sessionId: "missing", messageId: "message" })).toBe(false);
  resolve(inspection);
  expect(await old).toBe(false);
  expect(openSession).not.toHaveBeenCalled();
});
