import { expect, it, vi } from "vitest";
import type { ConversationFollowerRequest } from "./codex-client-coordination";
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

it("dispatches validated queue controls only to their current owner and retains the request", async () => {
  const owner = { role: "owner" } as const;
  const handle = vi.fn(async ({ method }: ConversationFollowerRequest) => ({
    method,
    result: { applied: true },
  }));
  const manager = { getStreamRole: () => owner, handleThreadFollowerRequest: handle };
  const view = new ConversationCoordinationViewTarget(
    () => manager,
    () => {},
  );
  const request = {
    method: "thread-follower-remove-queued-message",
    params: { conversationId: "thread", messageId: "native-message" },
  };
  expect(await view.requestThreadFollower({ hostId: "remote", request })).toEqual({
    method: request.method,
    result: { applied: true },
  });
  expect(handle).toHaveBeenCalledWith(request);
  expect(handle.mock.calls[0]?.[0].params).toBe(request.params);
});

it("rejects queue controls before dispatch if their owner changed during asynchronous admission", async () => {
  const original = { role: "owner" } as const;
  let resolve!: (role: typeof original) => void;
  const pending = new Promise<typeof original>((done) => {
    resolve = done;
  });
  const handle = vi.fn(async ({ method }: { method: string }) => ({
    method,
    result: { applied: true },
  }));
  let role: { role: "owner" | "follower" } = original;
  let reads = 0;
  const manager = {
    getStreamRole: () => (reads++ === 0 ? pending : role),
    handleThreadFollowerRequest: handle,
  };
  const view = new ConversationCoordinationViewTarget(
    () => manager,
    () => {},
  );
  const request = view.requestThreadFollower({
    hostId: "local",
    request: {
      method: "thread-follower-clear-queued-messages",
      params: { conversationId: "thread" },
    },
  });
  role = { role: "owner" };
  resolve(original);
  await expect(request).rejects.toThrow("owner changed");
  expect(handle).not.toHaveBeenCalled();
});

it("rejects malformed requests and direct follower targets before queue side effects", async () => {
  const handle = vi.fn(async ({ method }: { method: string }) => ({
    method,
    result: { applied: true },
  }));
  const manager = {
    getStreamRole: () => ({ role: "follower" }) as const,
    handleThreadFollowerRequest: handle,
  };
  const getManager = vi.fn(() => manager);
  const view = new ConversationCoordinationViewTarget(getManager, () => {});
  await expect(
    view.requestThreadFollower({
      hostId: "local",
      request: {
        method: "thread-follower-remove-queued-message",
        params: { conversationId: "thread" },
      },
    }),
  ).rejects.toThrow("identity");
  expect(getManager).not.toHaveBeenCalled();
  await expect(
    view.requestThreadFollower({
      hostId: "local",
      request: {
        method: "thread-follower-clear-queued-messages",
        params: { conversationId: "thread" },
      },
    }),
  ).rejects.toThrow("not the owner");
  expect(handle).not.toHaveBeenCalled();
});

it("does not confirm a queued control after its receiving owner incarnation is replaced", async () => {
  let owner = { role: "owner" } as const;
  let release!: (value: { method: string; result: { applied: boolean } }) => void;
  const pending = new Promise<{ method: string; result: { applied: boolean } }>((resolve) => {
    release = resolve;
  });
  const handle = vi.fn(() => pending);
  const view = new ConversationCoordinationViewTarget(
    () => ({ getStreamRole: () => owner, handleThreadFollowerRequest: handle }),
    () => {},
  );
  const received = view.requestThreadFollower({
    hostId: "remote",
    request: {
      method: "thread-follower-clear-queued-messages",
      params: { conversationId: "thread" },
    },
  });
  await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
  owner = { role: "owner" };
  release({ method: "thread-follower-clear-queued-messages", result: { applied: true } });
  await expect(received).rejects.toThrow("changed before confirmation");
});
