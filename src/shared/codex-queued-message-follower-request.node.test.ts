import { describe, expect, test } from "vite-plus/test";
import {
  parseCodexQueuedMessageFollowerRequest,
  parseCodexQueuedMessageFollowerResult,
} from "./codex-queued-message-follower-request";
import { conversationFollowerRequest } from "./codex-thread-follower-request";
import { acceptsCodexPeerRequestVersion, codexPeerRequestVersion } from "./codex-peer-protocol";

describe("queued message follower controls", () => {
  test("preserves the exact targeted identity through typed framing on local and qualified hosts", () => {
    const params = { conversationId: "thread", messageId: "native-message" };
    const request = conversationFollowerRequest("thread-follower-remove-queued-message", params);
    expect(parseCodexQueuedMessageFollowerRequest(request.method, request.params).params).toBe(
      params,
    );
    for (const hostId of [undefined, "remote-a"]) {
      const version = codexPeerRequestVersion(request.method, params, hostId);
      expect(version).toBe(hostId === undefined ? 1 : 2);
      expect(
        acceptsCodexPeerRequestVersion({
          type: "request",
          requestId: "request",
          sourceClientId: "follower",
          method: request.method,
          params,
          version,
          hostId,
        }),
      ).toBe(true);
    }
    const clear = conversationFollowerRequest("thread-follower-clear-queued-messages", {
      conversationId: "thread",
    });
    expect(parseCodexQueuedMessageFollowerRequest(clear.method, clear.params)).toEqual(clear);
  });

  test("rejects missing target identities and never admits native enqueue or reorder through this grammar", () => {
    for (const params of [null, [], {}, { conversationId: " " }, { conversationId: "thread" }])
      expect(() =>
        parseCodexQueuedMessageFollowerRequest("thread-follower-remove-queued-message", params),
      ).toThrow();
    for (const messageId of [null, false, 1, "", " "])
      expect(() =>
        parseCodexQueuedMessageFollowerRequest("thread-follower-remove-queued-message", {
          conversationId: "thread",
          messageId,
        }),
      ).toThrow();
    for (const method of ["thread/queue/add", "thread/queue/reorder", "thread-follower-enqueue"])
      expect(() =>
        parseCodexQueuedMessageFollowerRequest(method, { conversationId: "thread" }),
      ).toThrow();
  });

  test("requires a semantic result even when the transport reports success", () => {
    expect(parseCodexQueuedMessageFollowerResult({ applied: false })).toEqual({ applied: false });
    const applied = { applied: true };
    expect(parseCodexQueuedMessageFollowerResult(applied)).toBe(applied);
    for (const value of [undefined, null, [], {}, { ok: true }, { applied: "true" }])
      expect(() => parseCodexQueuedMessageFollowerResult(value)).toThrow();
  });
});
