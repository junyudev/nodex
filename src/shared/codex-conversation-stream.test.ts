import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatches, enablePatches, type Patch } from "immer";
import { ConversationStream, type ConversationStreamOptions } from "./codex-conversation-stream";

enablePatches();
type Document = { id: string; text: string };
const snapshot = (revision: number, text = "initial") => ({
  type: "snapshot" as const,
  revision,
  conversationState: { id: "thread", text },
});
const patch = (baseRevision: number, revision: number, text = "updated") => ({
  type: "patches" as const,
  baseRevision,
  revision,
  patches: [{ op: "replace", path: ["text"], value: text }] satisfies Patch[],
});

function setup() {
  const documents = new Map<string, Document>([["thread", { id: "thread", text: "initial" }]]);
  const options = {
    hostId: "local",
    isLocalHost: true,
    canHandleOwnerlessDynamicTool: () => false,
    transport: {
      sendState:
        vi.fn<ConversationStreamOptions<Document, Patch, never>["transport"]["sendState"]>(),
      sendFollowing: vi.fn(),
      requestFollowingStatus: vi.fn(),
      setThreadOwnership: vi.fn(),
    },
    getConversation: (id: string) => documents.get(id),
    normalizeSnapshot: (document: Document) => document,
    applyPatches: (document: Document, patches: readonly Patch[]) =>
      applyPatches(document, [...patches]),
    setConversation: (document: Document) => {
      documents.set(document.id, document);
    },
    notifyConversation: vi.fn(),
    onRoleChanged: vi.fn(),
    onFollowersChanged: vi.fn(),
    onOwnerUnavailable: vi.fn(),
    onError: vi.fn(),
    schedule: (callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  } satisfies ConversationStreamOptions<Document, Patch, never>;
  return { stream: new ConversationStream(options), documents, ...options };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("conversation stream ownership and publication", () => {
  it("selects the first window that can acquire a stream, otherwise the last registered activity", () => {
    const { stream } = setup();
    const changed = vi.fn();
    const hidden = {
      canAcquireThreadStream: false,
      routePath: "/a",
      visibilityState: "hidden" as const,
    };
    const a = stream.registerWindowActivity(hidden, changed);
    const b = stream.registerWindowActivity({ ...hidden, routePath: "/b" }, changed);
    expect(stream.getWindowActivity()?.routePath).toBe("/b");
    a.update({ ...hidden, canAcquireThreadStream: true });
    b.update({ ...hidden, routePath: "/b", canAcquireThreadStream: true });
    expect(stream.getWindowActivity()?.routePath).toBe("/a");
    a[Symbol.dispose]();
    a.update(hidden);
    expect(stream.getWindowActivity()?.routePath).toBe("/b");
    expect(changed).toHaveBeenCalledTimes(5);
    stream.dispose();
    b[Symbol.dispose]();
    expect(stream.getWindowActivity()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(5);
  });

  it("suppresses follower mutations without suppressing independent thread metadata", () => {
    const base = setup();
    const canHandleOwnerlessDynamicTool = vi.fn(() => true);
    const stream = new ConversationStream({ ...base, canHandleOwnerlessDynamicTool });
    expect(stream.shouldHandleDynamicToolCall(null)).toBe(false);
    expect(stream.shouldHandleDynamicToolCall("thread")).toBe(true);
    stream.setRole("thread", { role: "follower", ownerClientId: "a" });
    for (const method of [
      "turn/started",
      "item/tool/call",
      "thread/started",
      "thread/realtime/itemAdded",
      "thread/status/changed",
      "thread/tokenUsage/updated",
      "error",
    ]) {
      expect(stream.shouldIgnoreThreadMutationAsFollower(method, { threadId: "thread" })).toBe(
        true,
      );
      expect(
        stream.shouldIgnoreThreadMutationAsFollower(method, { thread: { id: "thread" } }),
      ).toBe(true);
      expect(stream.shouldIgnoreThreadMutationAsFollower(method, { threadId: "another" })).toBe(
        false,
      );
    }
    for (const method of [
      "thread/name/updated",
      "thread/settings/updated",
      "thread/goal/updated",
    ]) {
      expect(stream.shouldIgnoreThreadMutationAsFollower(method, { threadId: "thread" })).toBe(
        false,
      );
    }
    expect(stream.shouldHandleDynamicToolCall("thread")).toBe(false);
    expect(stream.ownsConversationHistoryStream("thread")).toBe(false);
    stream.setRole("thread", { role: "owner" });
    expect(stream.shouldHandleDynamicToolCall("thread")).toBe(true);
    expect(stream.ownsConversationHistoryStream("thread")).toBe(true);
    expect(canHandleOwnerlessDynamicTool).toHaveBeenCalledOnce();
  });

  it("counts publication attempts and recipients even if a transport send fails", async () => {
    const { stream, transport } = setup();
    stream.setRole("thread", { role: "owner" });
    stream.receiveFollowing("thread", "a", true);
    stream.receiveFollowing("thread", "b", true);
    transport.sendState.mockRejectedValueOnce(new Error("closed"));
    stream.broadcastPatches("thread", patch(0, 1).patches);
    await Promise.resolve();
    expect(stream.collectSnapshotFields()).toEqual({
      manager_stream_threads_with_followers: 1,
      manager_stream_follower_subscriptions: 2,
      manager_stream_snapshot_publications_total: 2,
      manager_stream_snapshot_recipients_total: 2,
      manager_stream_patch_publications_total: 1,
      manager_stream_patch_recipients_total: 2,
    });
    expect(stream.resetAfterReconnect(true)).toEqual({
      previousStreamingCount: 1,
      previousRoleCount: 1,
    });
    expect(stream.getRole("thread")).toEqual({ role: "owner" });
  });

  it("retains accepted text edits and derives the affected entity set for the presentation store", () => {
    type TextChange = {
      key: { entityKey: string };
      edits: { at: number; deleteCount: number; insert: string }[];
    };
    const base = setup();
    const setConversation = vi.fn();
    const stream = new ConversationStream<Document, Patch, TextChange>({
      ...base,
      transport: { ...base.transport, sendState: vi.fn() },
      setConversation,
    });
    stream.setFollowing("thread", true);
    stream.receiveState("thread", "owner", snapshot(1));
    const acceptedTextChanges: TextChange[] = [
      { key: { entityKey: "turn:a" }, edits: [{ at: 0, deleteCount: 0, insert: "汉" }] },
      { key: { entityKey: "turn:a" }, edits: [{ at: 1, deleteCount: 0, insert: "字" }] },
      { key: { entityKey: "turn:b" }, edits: [{ at: 0, deleteCount: 2, insert: "😀" }] },
    ];
    stream.receiveState("thread", "owner", { ...patch(1, 2), acceptedTextChanges });
    expect(setConversation).toHaveBeenLastCalledWith(
      { id: "thread", text: "updated" },
      {
        patches: patch(1, 2).patches,
        acceptedTranscriptText: {
          changes: acceptedTextChanges,
          turnEntityKeys: new Set(["turn:a", "turn:b"]),
        },
      },
    );
  });

  it("publishes only for followers and reuses the current revision for additional subscriptions", () => {
    const { stream, transport } = setup();
    stream.setRole("thread", { role: "owner" });
    stream.broadcastPatches("thread", patch(0, 1).patches);
    expect(stream.getRevision("thread")).toBeNull();
    expect(transport.sendState).not.toHaveBeenCalled();
    stream.receiveFollowing("thread", "a", true);
    stream.receiveFollowing("thread", "b", true);
    stream.receiveFollowing("thread", "b", true);
    expect(transport.sendState.mock.calls.map((call) => [call[2], call[3].revision])).toEqual([
      [["a"], 1],
      [["b"], 1],
      [["b"], 1],
    ]);
    stream.broadcastPatches("thread", patch(0, 1).patches);
    expect(transport.sendState).toHaveBeenLastCalledWith(
      "thread",
      "local",
      ["a", "b"],
      expect.objectContaining({ baseRevision: 1, revision: 2 }),
    );
    stream.receiveFollowing("thread", "a", false);
    stream.receiveFollowing("thread", "b", false);
    stream.broadcastPatches("thread", patch(0, 1).patches);
    expect(stream.getRevision("thread")).toBe(2);
  });

  it("advances before sending without serializing later publications behind a send result", async () => {
    const { stream, transport, onError } = setup();
    stream.setRole("thread", { role: "owner" });
    stream.receiveFollowing("thread", "a", true);
    transport.sendState.mockImplementation(() => {
      expect(stream.getRevision("thread")).toBe(transport.sendState.mock.lastCall?.[3].revision);
      return Promise.reject(new Error("disconnected"));
    });
    stream.broadcastPatches("thread", patch(0, 1).patches);
    stream.broadcastPatches("thread", patch(0, 1).patches);
    expect(stream.getRevision("thread")).toBe(3);
    expect(transport.sendState).toHaveBeenCalledTimes(3);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(stream.getRole("thread")).toEqual({ role: "owner" });
  });

  it("ignores unrequested state, then lets snapshots replace owners and rewind revisions", () => {
    const { stream, documents } = setup();
    stream.receiveState("thread", "a", snapshot(9));
    expect(stream.getRevision("thread")).toBeNull();
    stream.setFollowing("thread", true);
    stream.setRole("thread", { role: "owner" });
    stream.receiveState("thread", "a", snapshot(9));
    stream.receiveState("thread", "b", snapshot(1, "replacement"));
    expect(stream.getRole("thread")).toEqual({ role: "follower", ownerClientId: "b" });
    expect(stream.getRevision("thread")).toBe(1);
    expect(documents.get("thread")?.text).toBe("replacement");
  });

  it("drops mismatched patches and accepts any resulting revision when the base matches", () => {
    const { stream, documents, transport } = setup();
    stream.setFollowing("thread", true);
    stream.receiveState("thread", "a", patch(0, 1));
    stream.receiveState("thread", "a", snapshot(2));
    stream.receiveState("thread", "b", patch(2, 3));
    stream.receiveState("thread", "a", patch(3, 4));
    expect(documents.get("thread")?.text).toBe("initial");
    stream.receiveState("thread", "a", patch(2, 8));
    expect(stream.getRevision("thread")).toBe(8);
    expect(documents.get("thread")?.text).toBe("updated");
    expect(transport.sendState).not.toHaveBeenCalled();
  });

  it("keeps the baseline after patch failure without requesting recovery", () => {
    const { stream, transport, onError } = setup();
    stream.setFollowing("thread", true);
    stream.receiveState("thread", "a", snapshot(2));
    stream.receiveState("thread", "a", {
      ...patch(2, 3),
      patches: [{ op: "replace", path: ["missing", "child"], value: 1 }],
    });
    expect(stream.getRevision("thread")).toBe(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(transport.requestFollowingStatus).not.toHaveBeenCalled();
    expect(transport.sendFollowing).toHaveBeenCalledOnce();
  });

  it("retains stream roles across IPC reset while expiring disconnected follower protection", () => {
    vi.useFakeTimers();
    const { stream, onFollowersChanged } = setup();
    stream.setRole("thread", { role: "owner" });
    stream.receiveFollowing("thread", "a", true);
    stream.resetIpcConnection();
    expect(stream.getFollowerClientIds("thread")).toEqual([]);
    expect(stream.hasFollowersOrPendingReconnect("thread")).toBe(true);
    expect(stream.getRevision("thread")).toBe(1);
    vi.advanceTimersByTime(4_999);
    expect(stream.hasFollowersOrPendingReconnect("thread")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(stream.hasFollowersOrPendingReconnect("thread")).toBe(false);
    expect(onFollowersChanged).toHaveBeenCalledTimes(2);
    expect(stream.getRole("thread")).toEqual({ role: "owner" });
    stream.resetAfterReconnect();
    expect(stream.getRole("thread")).toBeNull();
    expect(stream.getRevision("thread")).toBeNull();
  });

  it("reannounces locally retained follow intents on client connection", () => {
    const { stream, transport } = setup();
    stream.setFollowing("thread", true);
    stream.receiveClientStatus("b", "connected");
    stream.receiveClientStatus("self", "connected", true);
    expect(transport.sendFollowing.mock.calls).toEqual([
      ["thread", "local", true, undefined],
      ["thread", "local", true, ["b"]],
      ["thread", "local", true, undefined],
    ]);
  });

  it("settles history waiters only when the matching owner's revision arrives", async () => {
    const { stream } = setup();
    stream.setFollowing("thread", true);
    stream.receiveState("thread", "a", snapshot(1));
    const settled = vi.fn();
    const result = stream.waitForRevision("thread", "a", 4, 100).then(settled);
    stream.receiveState("thread", "b", patch(1, 4));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    stream.receiveState("thread", "a", patch(1, 4));
    await result;
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(["owner-change", "disconnect", "unfollow", "dispose"])(
    "rejects pending waiters on %s",
    async (action) => {
      const { stream } = setup();
      stream.setFollowing("thread", true);
      stream.receiveState("thread", "a", snapshot(1));
      const result = expect(stream.waitForRevision("thread", "a", 4, 100)).rejects.toThrow();
      if (action === "owner-change") stream.receiveState("thread", "b", snapshot(1));
      if (action === "disconnect") stream.receiveClientStatus("a", "disconnected");
      if (action === "unfollow") stream.setFollowing("thread", false);
      if (action === "dispose") stream.dispose();
      await result;
    },
  );
});
