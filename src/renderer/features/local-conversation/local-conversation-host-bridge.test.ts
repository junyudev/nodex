import { afterEach, describe, expect, vi, test } from "vite-plus/test";
import type { CodexHostMessage } from "../../../shared/types";
import {
  __resetCodexAppServerMessageBusForTests,
  subscribeCodexAppServerMessage,
} from "./app-server-message-bus";
import {
  __resetLocalConversationHostBridgeForTests,
  startLocalConversationHostBridge,
} from "./local-conversation-host-bridge";

const fixture = vi.hoisted(() => ({
  listener: null as ((message: CodexHostMessage) => void) | null,
  releases: 0,
}));

vi.mock("./local-conversation-deps", () => ({
  subscribeCodexHostMessages: (listener: (message: CodexHostMessage) => void) => {
    fixture.listener = listener;
    return () => {
      fixture.listener = null;
      fixture.releases++;
    };
  },
}));

afterEach(() => {
  __resetLocalConversationHostBridgeForTests();
  __resetCodexAppServerMessageBusForTests();
  fixture.releases = 0;
});

describe("local conversation host bridge", () => {
  test("preserves native notification payload and physical occurrence identity", () => {
    const received: unknown[] = [];
    subscribeCodexAppServerMessage("native-notification", (event) => received.push(event));
    startLocalConversationHostBridge();
    const message: CodexHostMessage = {
      type: "nativeNotification",
      hostId: "remote-host",
      generation: 7,
      occurrenceId: "native-42",
      occurrenceToken: 42,
      notification: {
        method: "item/agentMessage/delta",
        params: { threadId: "thread", turnId: "turn", itemId: "item", delta: "x".repeat(300_000) },
      },
    };
    fixture.listener?.(message);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(message);
  });

  test("preserves native request IDs and the occurrence needed to respond", () => {
    const received: unknown[] = [];
    subscribeCodexAppServerMessage("native-request", (event) => received.push(event));
    startLocalConversationHostBridge();
    const message: CodexHostMessage = {
      type: "nativeRequest",
      hostId: "local",
      generation: 2,
      occurrenceId: "request-0",
      occurrenceToken: 9,
      request: {
        method: "item/tool/call",
        id: 0,
        params: {
          threadId: "thread",
          turnId: "turn",
          callId: "call",
          namespace: null,
          tool: "custom",
          arguments: {},
        },
      },
    };
    fixture.listener?.(message);
    expect(received[0]).toBe(message);
  });

  test("delivers connection context before the corresponding status observation", () => {
    const order: unknown[] = [];
    subscribeCodexAppServerMessage("shared-object-updated", (event) => order.push(event));
    subscribeCodexAppServerMessage("client-status-changed", (event) => order.push(event));
    startLocalConversationHostBridge();
    const message: CodexHostMessage = {
      type: "sharedObjectUpdated",
      hostId: "local",
      object: {
        objectType: "connection",
        objectId: "connection",
        value: { status: "connected", retries: 0 },
      },
    };
    fixture.listener?.(message);
    expect(order).toEqual([
      { hostId: "local", object: message.object },
      { hostId: "local", status: "connected" },
    ]);
  });

  test("keeps title, deletion and host error observations available", () => {
    const received: unknown[] = [];
    subscribeCodexAppServerMessage("thread-title-updated", (event) => received.push(event));
    subscribeCodexAppServerMessage("thread-deleted", (event) => received.push(event));
    subscribeCodexAppServerMessage("error", (event) => received.push(event));
    startLocalConversationHostBridge();
    fixture.listener?.({
      type: "threadTitleUpdated",
      hostId: "local",
      conversationId: "thread",
      title: "Renamed",
    });
    fixture.listener?.({ type: "threadDeleted", hostId: "local", threadId: "thread" });
    fixture.listener?.({
      type: "error",
      hostId: "local",
      message: "Request failed",
      detail: "Unavailable",
    });
    expect(received).toEqual([
      { hostId: "local", conversationId: "thread", title: "Renamed" },
      { hostId: "local", threadId: "thread" },
      { hostId: "local", message: "Request failed", detail: "Unavailable" },
    ]);
  });

  test("keeps the host subscription alive until its final consumer releases", () => {
    const first = startLocalConversationHostBridge();
    const second = startLocalConversationHostBridge();
    first();
    expect(fixture.listener).not.toBeNull();
    expect(fixture.releases).toBe(0);
    second();
    expect(fixture.listener).toBeNull();
    expect(fixture.releases).toBe(1);
  });
});
