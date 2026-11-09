import type { ChatSummary } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import { attentionCount, chatListRows, chatStatusTone } from "./chat-sections";

const chat = (sessionId: string, overrides: Partial<ChatSummary> = {}): ChatSummary => ({
  sessionId,
  title: sessionId,
  preview: "",
  projectId: null,
  projectName: null,
  agentLabel: null,
  status: "idle",
  pendingRequestCount: 0,
  attention: null,
  unread: false,
  pinned: false,
  archived: false,
  activityAt: null,
  canSend: true,
  canManage: true,
  ...overrides,
});

const shape = (chats: readonly ChatSummary[]) =>
  chatListRows(chats).map((row) => (row.type === "header" ? `#${row.id}` : row.chat.sessionId));

describe("chatListRows", () => {
  it("needs no headers when every chat is simply recent", () => {
    expect(shape([chat("a"), chat("b")])).toEqual(["a", "b"]);
  });

  it("puts what needs the person first and keeps the Host's order within a section", () => {
    expect(
      shape([
        chat("idle-1"),
        chat("run-1", { status: "running" }),
        chat("ask-1", { status: "waiting", pendingRequestCount: 1 }),
        chat("idle-2"),
        chat("run-2", { status: "background" }),
        chat("ask-2", { status: "running", pendingRequestCount: 1 }),
      ]),
    ).toEqual([
      "#attention",
      "ask-1",
      "ask-2",
      "#working",
      "run-1",
      "run-2",
      "#recent",
      "idle-1",
      "idle-2",
    ]);
  });

  it("does not ask this Member to answer another Member’s waiting chat", () => {
    const waiting = chat("someone-else", { status: "waiting", pendingRequestCount: 0 });
    expect(shape([waiting])).toEqual(["#working", "someone-else"]);
    expect(attentionCount([waiting])).toBe(0);
  });

  it("omits an empty section's header", () => {
    expect(shape([chat("run", { status: "running" })])).toEqual(["#working", "run"]);
  });

  it("returns nothing for no chats", () => {
    expect(shape([])).toEqual([]);
  });

  it("keeps archived chats in the Host's order, whatever they last showed", () => {
    const archived = [
      chat("old", { archived: true }),
      chat("stale-run", { archived: true, status: "running" }),
      chat("stale-ask", { archived: true, status: "waiting", pendingRequestCount: 1 }),
    ];
    expect(
      chatListRows(archived, { archived: true }).map((row) =>
        row.type === "chat" ? row.chat.sessionId : `#${row.id}`,
      ),
    ).toEqual(["old", "stale-run", "stale-ask"]);
  });
});

describe("attentionCount", () => {
  it("counts a running chat with a pending request", () => {
    expect(
      attentionCount([
        chat("a", { status: "waiting", pendingRequestCount: 1 }),
        chat("b", { status: "running", pendingRequestCount: 2 }),
        chat("c", { status: "running" }),
      ]),
    ).toBe(2);
  });
});

describe("chatStatusTone", () => {
  it("gives idle no mark", () => {
    expect(chatStatusTone("idle")).toBeNull();
  });
});
