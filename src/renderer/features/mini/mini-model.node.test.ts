import type { ChatSummary, InboxEntry } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  miniAttentionCount,
  miniCards,
  miniStartSettled,
  type MiniDismissal,
  type MiniStart,
} from "./mini-model";

const chat = (sessionId: string, fields: Partial<ChatSummary>): ChatSummary => ({
  sessionId,
  title: sessionId,
  preview: "",
  projectId: null,
  projectName: null,
  agentLabel: null,
  status: "idle",
  pendingRequestCount: 0,
  attention: null,
  progress: null,
  unread: false,
  pinned: false,
  archived: false,
  activityAt: 1,
  canSend: true,
  canManage: true,
  ...fields,
});

const turn = (
  pageId: string,
  reason: string,
  fields: { readonly chatSessionId?: string; readonly since?: string } = {},
): InboxEntry =>
  ({
    rowKind: "turn",
    id: `entry-${pageId}`,
    pageId,
    title: pageId,
    body: "Ready to review.\nDetails follow.",
    scope: { kind: "library" },
    turn: {
      episode: `${pageId}-1`,
      reason,
      since: fields.since ?? "2026-11-27T10:00:00.000Z",
      options: [],
      replyCapability: { kind: "available" },
      chatSessionId: fields.chatSessionId ?? null,
      pullRequestUrl: null,
      deliveryError: null,
    },
  }) as unknown as InboxEntry;

const start = (sessionId: string, fields: Partial<MiniStart> = {}): MiniStart => ({
  sessionId,
  launchId: `${sessionId}-launch`,
  messageId: `${sessionId}-message`,
  projectId: null,
  project: null,
  draft: { title: "", text: sessionId, images: [] },
  startedAt: 4,
  status: "sending",
  sentAt: null,
  error: null,
  ...fields,
});

const cardsOf = (input: {
  readonly chats?: readonly ChatSummary[];
  readonly chatsReadAt?: number;
  readonly inbox?: readonly InboxEntry[];
  readonly starts?: readonly MiniStart[];
  readonly dismissed?: readonly MiniDismissal[];
}) =>
  miniCards({
    chats: input.chats ?? [],
    chatsReadAt: input.chatsReadAt ?? 0,
    inbox: input.inbox ?? [],
    starts: input.starts ?? [],
    dismissed: input.dismissed ?? [],
    projectName: () => null,
  });

describe("miniCards", () => {
  it("leads with what the person just started, then needs them, failed, done and working", () => {
    const cards = cardsOf({
      chats: [
        chat("working-old", { status: "running", activityAt: 1 }),
        chat("done", { unread: true, activityAt: 5 }),
        chat("waiting", { status: "waiting", attention: "Approve the migration?", activityAt: 2 }),
        chat("working-new", { status: "background", activityAt: 9 }),
        chat("failed", { status: "failed", activityAt: 3 }),
        chat("read-idle", { activityAt: 99 }),
        chat("mine", { status: "running", activityAt: 0 }),
      ],
      starts: [start("new"), start("mine", { status: "sent", sentAt: 1 })],
    });
    expect(cards.map((card) => card.sessionId)).toEqual([
      "new",
      "mine",
      "waiting",
      "failed",
      "done",
      "working-new",
      "working-old",
    ]);
    expect(cards[2]).toMatchObject({ line: "Approve the migration?" });
    // Only what waits on the person is counted; work in progress never is.
    expect(miniAttentionCount(cards)).toBe(2);
  });

  it("lets a Page Turn about a chat stand in for that chat's card", () => {
    const cards = cardsOf({
      chats: [chat("s1", { status: "waiting" }), chat("s2", { status: "running" })],
      inbox: [turn("p1", "review", { chatSessionId: "s1" }), turn("p2", "working")],
    });
    expect(cards.map((card) => card.key)).toEqual(["turn:p1:p1-1", "chat:s2"]);
    expect(cards[0]).toMatchObject({ kind: "turn", line: "Ready to review.", sessionId: "s1" });
  });

  it("keeps a start until the chat list settles it, and a failed one until it is handled", () => {
    const starts = [
      start("listed", { status: "sent", sentAt: 1 }),
      start("refused", { status: "failed", error: "Offline" }),
      start("archived", { status: "sent", sentAt: 1 }),
      start("unseen", { status: "sent", sentAt: 10 }),
    ];
    const chats = [chat("listed", { unread: true, activityAt: 2 })];
    expect(miniStartSettled(starts[0]!, chats, 5)).toBe(true);
    expect(miniStartSettled(starts[1]!, chats, 5)).toBe(false);
    expect(miniStartSettled(starts[2]!, chats, 5)).toBe(true);
    expect(miniStartSettled(starts[3]!, chats, 5)).toBe(false);
    const cards = cardsOf({ chats, chatsReadAt: 5, starts });
    expect(cards.map((card) => [card.kind, card.sessionId, card.tone])).toEqual([
      ["starting", "refused", "failed"],
      ["starting", "unseen", "starting"],
      ["chat", "listed", "done"],
    ]);
  });

  it("hides a dismissed card until it changes, however its live line moves", () => {
    const working = cardsOf({ chats: [chat("s1", { status: "running", activityAt: 1 })] });
    const dismissed = working.map(({ key, version }) => ({ key, version }));
    const progressed = chat("s1", { status: "running", progress: "Reading files", activityAt: 7 });
    expect(cardsOf({ chats: [progressed], dismissed })).toEqual([]);
    expect(cardsOf({ chats: [chat("s1", { unread: true, activityAt: 9 })], dismissed })).toEqual([
      expect.objectContaining({ key: "chat:s1", tone: "done" }),
    ]);
    const done = cardsOf({ chats: [chat("s1", { unread: true, activityAt: 9 })] });
    const later = chat("s1", { unread: true, activityAt: 12 });
    expect(cardsOf({ chats: [later], dismissed: [done[0]!] })).toHaveLength(1);
  });
});
