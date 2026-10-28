import { describe, expect, test, vi } from "vite-plus/test";

import {
  sendPageToChatWithRelation,
  type PagePromptContext,
  type SendPageToChatInput,
} from "./page-chat-actions";

const pageInput = (target: SendPageToChatInput["target"]): SendPageToChatInput => ({
  projectId: "project-page",
  pageId: "page-1",
  pageKey: "LAB-1",
  titleSnapshot: "Release plan",
  target,
});

const context: PagePromptContext = {
  projectId: "project-page",
  pageId: "page-1",
  pageKey: "LAB-1",
  title: "Release plan",
  source: "nodex://pages/page-1",
  promptInput: { text: "Page: Release plan" },
};

type SendDependencies = Parameters<typeof sendPageToChatWithRelation>[1];

function dependencies(overrides: Partial<SendDependencies> = {}) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      loadPageContext: vi.fn(async () => {
        calls.push("snapshot");
        return context;
      }),
      resolveSessionById: vi.fn(async () => {
        calls.push("resolve-session");
        return { id: "session-target", projectId: "project-target" };
      }),
      resolveSessionForThread: vi.fn(async () => {
        calls.push("resolve-thread");
        return { id: "session-target", projectId: "project-target" };
      }),
      ensureDefaultSession: vi.fn(async () => {
        calls.push("ensure-default");
        return { id: "session-default", projectId: "project-page" };
      }),
      linkPage: vi.fn(async () => {
        calls.push("link");
      }),
      startTurn: vi.fn(async () => {
        calls.push("start-turn");
      }),
      startThread: vi.fn(async () => {
        calls.push("start-thread");
        return { kind: "started" };
      }),
      refreshSessions: vi.fn(async () => {
        calls.push("refresh");
      }),
      ...overrides,
    },
  };
}

describe("sendPageToChatWithRelation", () => {
  test("orders canonical snapshot, target resolution, durable link, then existing Turn", async () => {
    const runtime = dependencies();
    await sendPageToChatWithRelation(
      pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
      runtime.value,
    );
    expect(runtime.calls).toEqual(["snapshot", "resolve-thread", "link", "start-turn"]);
    expect(runtime.value.linkPage).toHaveBeenCalledWith({
      pageAccessProjectId: "project-page",
      pageId: "page-1",
      sessionId: "session-target",
    });
    expect(runtime.value.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-target", threadId: "thread-target" }),
    );
  });

  test("does not link or send when the Page snapshot fails", async () => {
    const runtime = dependencies({
      loadPageContext: vi.fn(async () => {
        runtime.calls.push("snapshot");
        throw new Error("Page unavailable");
      }),
    });
    await expect(
      sendPageToChatWithRelation(
        pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
        runtime.value,
      ),
    ).rejects.toThrow("Page unavailable");
    expect(runtime.calls).toEqual(["snapshot"]);
  });

  test("does not link or send when target Session resolution fails", async () => {
    const runtime = dependencies({
      resolveSessionForThread: vi.fn(async () => {
        runtime.calls.push("resolve-thread");
        throw new Error("Chat unavailable");
      }),
    });
    await expect(
      sendPageToChatWithRelation(
        pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
        runtime.value,
      ),
    ).rejects.toThrow("Chat unavailable");
    expect(runtime.calls).toEqual(["snapshot", "resolve-thread"]);
  });

  test("does not start a Turn when the durable link fails", async () => {
    const runtime = dependencies({
      linkPage: vi.fn(async () => {
        runtime.calls.push("link");
        throw new Error("Store unavailable");
      }),
    });
    await expect(
      sendPageToChatWithRelation(
        pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
        runtime.value,
      ),
    ).rejects.toThrow("Store unavailable");
    expect(runtime.calls).toEqual(["snapshot", "resolve-thread", "link"]);
  });

  test("keeps the durable relation when app-server Turn start fails", async () => {
    const runtime = dependencies({
      startTurn: vi.fn(async () => {
        runtime.calls.push("start-turn");
        throw new Error("Agent unavailable");
      }),
    });
    await expect(
      sendPageToChatWithRelation(
        pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
        runtime.value,
      ),
    ).rejects.toThrow("Agent unavailable");
    expect(runtime.calls).toEqual(["snapshot", "resolve-thread", "link", "start-turn"]);
    expect(runtime.value.linkPage).toHaveBeenCalledTimes(1);
  });

  test("links a resolved blank Chat before starting its first Thread", async () => {
    const runtime = dependencies();
    await sendPageToChatWithRelation(
      pageInput({ kind: "new-thread", sessionId: "session-target" }),
      runtime.value,
    );
    expect(runtime.calls).toEqual([
      "snapshot",
      "resolve-session",
      "link",
      "start-thread",
      "refresh",
    ]);
  });
});
