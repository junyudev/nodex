import { expect, it, vi } from "vitest";
import {
  ConversationCoordinationViewTarget,
  type ConversationCoordinationManager,
} from "./codex-coordination-view";

it("waits for the selected manager role and resolves a fresh manager for the next call", async () => {
  let resolve!: (role: { role: "owner" }) => void;
  const pending = new Promise<{ role: "owner" }>((done) => {
    resolve = done;
  });
  const first = vi.fn(() => pending);
  let manager: ConversationCoordinationManager = {
    getStreamRole: first,
    handleThreadFollowerRequest: async ({ method }) => ({ method, result: null }),
  };
  const getManager = vi.fn(() => manager);
  const view = new ConversationCoordinationViewTarget(getManager, () => {});
  const settled = vi.fn();
  const role = view.getThreadRole({ hostId: "remote", conversationId: "thread" });
  void role.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(getManager).toHaveBeenCalledWith("remote");
  expect(first).toHaveBeenCalledWith("thread");
  manager = { ...manager, getStreamRole: () => null };
  resolve({ role: "owner" });
  expect(await role).toBe("owner");
  expect(await view.getThreadRole({ hostId: "remote", conversationId: "thread" })).toBe("follower");
});

it("propagates asynchronous role failures instead of reporting follower", async () => {
  const failure = new Error("manager unavailable");
  const view = new ConversationCoordinationViewTarget(
    () => ({
      getStreamRole: async () => {
        throw failure;
      },
      handleThreadFollowerRequest: async ({ method }) => ({ method, result: null }),
    }),
    () => {},
  );
  await expect(view.getThreadRole({ hostId: "local", conversationId: "thread" })).rejects.toBe(
    failure,
  );
});
