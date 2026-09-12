import { describe, expect, it, vi } from "vitest";
import type { ConversationCoordinationHost } from "./codex-client-coordination";
import type { CodexPeerResponse } from "./codex-peer-protocol";
import { requestConversationFollower } from "./codex-follower-request";

const method = "thread-follower-compact-thread";
const success: CodexPeerResponse = {
  type: "response",
  requestId: "request",
  resultType: "success",
  method,
  handledByClientId: "owner",
  result: { ok: true },
};

function serviceFor(pending: Promise<CodexPeerResponse>) {
  const request = vi.fn(() => pending);
  const service: ConversationCoordinationHost = {
    requestThreadFollower: request,
    threadArchived: async () => {},
    threadUnarchived: async () => {},
    threadQueuedFollowUpsChanged: async () => {},

    setThreadOwnership: async () => {},
    threadStreamStateChanged: async () => {},
    threadStreamFollowingChanged: async () => {},
    threadStreamFollowingStatusRequested: async () => {},
    findThreadOwner: async () => null,
  };
  return { service, request };
}

describe("follower request lifecycle", () => {
  it("preserves owner identity and forwards the selected host, target and deadline", async () => {
    const dispose = vi.fn();
    const pending = Object.assign(Promise.resolve(success), { [Symbol.dispose]: dispose });
    const { service, request } = serviceFor(pending);
    expect(
      await requestConversationFollower(
        service,
        method,
        { conversationId: "thread" },
        {
          hostId: "remote",
          targetClientId: "owner",
          timeoutMs: 300_000,
        },
      ),
    ).toEqual(success);
    expect(request).toHaveBeenCalledWith({
      hostId: "remote",
      targetClientId: "owner",
      timeoutMs: 300_000,
      request: { method, params: { conversationId: "thread" } },
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects a successful response for another method but retains remote errors", async () => {
    const wrong = serviceFor(Promise.resolve({ ...success, method: "another-method" }));
    expect(
      await requestConversationFollower(wrong.service, method, {}, { hostId: "local" }),
    ).toMatchObject({ resultType: "error", error: "thread-follower-response-method-mismatch" });
    const remote: CodexPeerResponse = {
      type: "response",
      requestId: "remote-request",
      resultType: "error",
      error: "no-client-found",
    };
    const failed = serviceFor(Promise.resolve(remote));
    expect(
      await requestConversationFollower(failed.service, method, {}, { hostId: "local" }),
    ).toEqual(remote);
  });

  it("does not dispatch an already cancelled request or require an unavailable service", async () => {
    const controller = new AbortController();
    controller.abort();
    const { service, request } = serviceFor(Promise.resolve(success));
    expect(
      await requestConversationFollower(
        service,
        method,
        {},
        {
          hostId: "local",
          signal: controller.signal,
        },
      ),
    ).toMatchObject({ resultType: "error", error: "aborted" });
    expect(request).not.toHaveBeenCalled();
    expect(await requestConversationFollower(null, method, {}, { hostId: "local" })).toMatchObject({
      resultType: "error",
      error: "client-coordination-service-unavailable",
    });
  });

  it("releases a cancelled call and consumes its later transport rejection", async () => {
    let rejectPending: (reason: Error) => void = () => {};
    const promise = new Promise<CodexPeerResponse>((_resolve, reject) => {
      rejectPending = reject;
    });
    const dispose = vi.fn();
    const { service } = serviceFor(Object.assign(promise, { [Symbol.dispose]: dispose }));
    const controller = new AbortController();
    const result = requestConversationFollower(
      service,
      method,
      {},
      {
        hostId: "local",
        signal: controller.signal,
      },
    );
    controller.abort();
    expect(await result).toMatchObject({ resultType: "error", error: "aborted" });
    expect(dispose).toHaveBeenCalledOnce();
    rejectPending(new Error("client-disconnected"));
    await Promise.resolve();
  });

  it("releases failed calls and removes abort listeners after transport settlement", async () => {
    const dispose = vi.fn();
    const { service } = serviceFor(
      Object.assign(Promise.reject(new Error("timeout")), {
        [Symbol.dispose]: dispose,
      }),
    );
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    expect(
      await requestConversationFollower(
        service,
        method,
        {},
        {
          hostId: "local",
          signal: controller.signal,
        },
      ),
    ).toMatchObject({ resultType: "error", error: "timeout" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
