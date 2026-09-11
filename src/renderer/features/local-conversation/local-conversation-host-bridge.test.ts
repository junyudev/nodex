import { beforeEach, describe, expect, vi, test } from "vite-plus/test";
import {
  __resetCodexAppServerMessageBusForTests,
  subscribeCodexAppServerMessage,
} from "./app-server-message-bus";

let hostMessageListener: ((message: unknown) => void) | null = null;

vi.mock("./local-conversation-deps", () => ({
  subscribeCodexHostMessages: (listener: (message: unknown) => void) => {
    hostMessageListener = listener;
    return () => {
      hostMessageListener = null;
    };
  },
  invoke: async () => null,
}));

async function loadHostBridgeModule() {
  return import("./local-conversation-host-bridge");
}

describe("local conversation host bridge", () => {
  beforeEach(() => {
    __resetCodexAppServerMessageBusForTests();
    hostMessageListener = null;
  });

  test("dispatches thread title updates onto the app-server message bus", async () => {
    const received: Array<{ conversationId: string; title: string }> = [];
    const unsubscribe = subscribeCodexAppServerMessage("thread-title-updated", (event) => {
      received.push({
        conversationId: event.conversationId,
        title: event.title,
      });
    });

    const { startLocalConversationHostBridge, __resetLocalConversationHostBridgeForTests } =
      await loadHostBridgeModule();
    const stop = startLocalConversationHostBridge();
    hostMessageListener?.({
      type: "threadTitleUpdated",
      hostId: "default",
      conversationId: "thread-1",
      title: "Backfill cached thread names",
    });

    expect(JSON.stringify(received)).toBe(
      JSON.stringify([
        {
          conversationId: "thread-1",
          title: "Backfill cached thread names",
        },
      ]),
    );

    stop();
    unsubscribe();
    __resetLocalConversationHostBridgeForTests();
  });

  test("preserves checkpoint replication evidence on thread stream events", async () => {
    const received: Array<{
      revision: number | null;
      baseRevision: number | null;
    }> = [];
    const unsubscribe = subscribeCodexAppServerMessage("thread-stream-state-changed", (event) => {
      received.push({
        revision: event.checkpoint?.revision ?? null,
        baseRevision: event.baseCheckpoint?.revision ?? null,
      });
    });

    const { startLocalConversationHostBridge, __resetLocalConversationHostBridgeForTests } =
      await loadHostBridgeModule();
    const stop = startLocalConversationHostBridge();
    hostMessageListener?.({
      type: "threadStreamStateChanged",
      hostId: "default",
      conversationId: "thread-1",
      change: {
        type: "patches",
        baseRevision: 1,
        revision: 2,
        patches: [],
      },
      version: 2,
      sourceClientId: "owner-a",
      baseCheckpoint: {
        protocolVersion: 1,
        ownerEpoch: 3,
        revision: 1,
      },
      checkpoint: {
        protocolVersion: 1,
        ownerEpoch: 3,
        revision: 2,
      },
    });

    expect(received).toEqual([
      {
        revision: 2,
        baseRevision: 1,
      },
    ]);

    stop();
    unsubscribe();
    __resetLocalConversationHostBridgeForTests();
  });

  test("dispatches host errors onto the app-server message bus", async () => {
    const received: Array<{ message: string; detail?: string }> = [];
    const unsubscribe = subscribeCodexAppServerMessage("error", (event) => {
      received.push({
        message: event.message,
        detail: event.detail,
      });
    });

    const { startLocalConversationHostBridge, __resetLocalConversationHostBridgeForTests } =
      await loadHostBridgeModule();
    const stop = startLocalConversationHostBridge();
    hostMessageListener?.({
      type: "error",
      hostId: "default",
      message: "Host request failed",
      detail: "boom",
    });

    expect(JSON.stringify(received)).toBe(
      JSON.stringify([
        {
          message: "Host request failed",
          detail: "boom",
        },
      ]),
    );

    stop();
    unsubscribe();
    __resetLocalConversationHostBridgeForTests();
  });

  test("dispatches deleted threads onto the app-server message bus", async () => {
    const received: string[] = [];
    const unsubscribe = subscribeCodexAppServerMessage("thread-deleted", (event) => {
      received.push(event.threadId);
    });

    const { startLocalConversationHostBridge, __resetLocalConversationHostBridgeForTests } =
      await loadHostBridgeModule();
    const stop = startLocalConversationHostBridge();
    hostMessageListener?.({
      type: "threadDeleted",
      hostId: "default",
      threadId: "thread-1",
    });

    expect(JSON.stringify(received)).toBe(JSON.stringify(["thread-1"]));

    stop();
    unsubscribe();
    __resetLocalConversationHostBridgeForTests();
  });

  test("dispatches owner-only thread notifications onto the app-server message bus", async () => {
    const received: Array<{ method: string; sequence: number; delta: string | null }> = [];
    const unsubscribe = subscribeCodexAppServerMessage("thread-owner-notification", (event) => {
      const params = event.notification.params as { delta?: unknown };
      received.push({
        method: event.notification.method,
        sequence: event.sequence,
        delta: typeof params?.delta === "string" ? params.delta : null,
      });
    });

    const { startLocalConversationHostBridge, __resetLocalConversationHostBridgeForTests } =
      await loadHostBridgeModule();
    const stop = startLocalConversationHostBridge();
    hostMessageListener?.({
      type: "threadOwnerNotification",
      hostId: "default",
      sequence: 7,
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "assistant-1",
          delta: "hello",
        },
      },
    });

    expect(JSON.stringify(received)).toBe(
      JSON.stringify([
        {
          method: "item/agentMessage/delta",
          sequence: 7,
          delta: "hello",
        },
      ]),
    );

    stop();
    unsubscribe();
    __resetLocalConversationHostBridgeForTests();
  });

  test("dispatches owner unavailable messages onto the app-server message bus", async () => {
    const received: Array<{ ownerClientId: string; conversationIds: string }> = [];
    const unsubscribe = subscribeCodexAppServerMessage("thread-owner-unavailable", (event) => {
      received.push({
        ownerClientId: event.ownerClientId,
        conversationIds: event.conversationIds.join(","),
      });
    });

    const { startLocalConversationHostBridge, __resetLocalConversationHostBridgeForTests } =
      await loadHostBridgeModule();
    const stop = startLocalConversationHostBridge();
    hostMessageListener?.({
      type: "threadOwnerUnavailable",
      hostId: "default",
      ownerClientId: "owner-a",
      conversationIds: ["thread-1", "thread-2"],
    });

    expect(JSON.stringify(received)).toBe(
      JSON.stringify([
        {
          ownerClientId: "owner-a",
          conversationIds: "thread-1,thread-2",
        },
      ]),
    );

    stop();
    unsubscribe();
    __resetLocalConversationHostBridgeForTests();
  });
});
