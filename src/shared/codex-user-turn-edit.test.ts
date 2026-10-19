import { describe, expect, test } from "vite-plus/test";
import {
  canEditCodexConversationUserTurns,
  resolveEditableUserTurnIds,
  type EditableUserTurnCandidate,
} from "./codex-user-turn-edit";

const settled = (turnId: string | null, hasUserMessage = true): EditableUserTurnCandidate => ({
  turnId,
  status: "completed",
  hasUserMessage,
});

describe("resolveEditableUserTurnIds", () => {
  test("offers every settled user message, not only the latest", () => {
    expect([
      ...resolveEditableUserTurnIds([
        settled("first"),
        { turnId: "interrupted", status: "interrupted", hasUserMessage: true },
        settled("latest"),
      ]),
    ]).toEqual(["first", "interrupted", "latest"]);
  });

  test("skips Turns without a user message or a Turn identity", () => {
    expect([
      ...resolveEditableUserTurnIds([settled("goal", false), settled(null), settled("asked")]),
    ]).toEqual(["asked"]);
  });

  test("offers nothing while any Turn runs, because the edit discards every later Turn", () => {
    expect(
      resolveEditableUserTurnIds([
        settled("first"),
        { turnId: "running", status: "inProgress", hasUserMessage: true },
      ]).size,
    ).toBe(0);
  });
});

describe("canEditCodexConversationUserTurns", () => {
  const conversation = (
    overrides: Partial<Parameters<typeof canEditCodexConversationUserTurns>[0]> = {},
  ): Parameters<typeof canEditCodexConversationUserTurns>[0] => ({
    archived: false,
    statusType: "idle",
    source: null,
    canonicalState: { historyMode: "paginated", ephemeral: false } as never,
    turns: [
      { turnId: "first", status: "completed", items: [{ kind: "userMessage" }] },
      { turnId: "second", status: "completed", items: [{ kind: "userMessage" }] },
    ] as never,
    ...overrides,
  });

  test("allows editing a persistent, idle conversation with sent messages", () => {
    expect(canEditCodexConversationUserTurns(conversation(), [])).toBe(true);
  });

  test.each([
    ["a pending request", conversation(), [{ requestId: 1 }]],
    [
      "a running Turn",
      conversation({
        turns: [{ turnId: "t", status: "inProgress", items: [{ kind: "userMessage" }] }] as never,
      }),
      [],
    ],
    [
      "no sent message",
      conversation({ turns: [{ turnId: "t", status: "completed", items: [] }] as never }),
      [],
    ],
    [
      "legacy history",
      conversation({ canonicalState: { historyMode: "legacy", ephemeral: false } as never }),
      [],
    ],
    [
      "ephemeral history",
      conversation({ canonicalState: { historyMode: "paginated", ephemeral: true } as never }),
      [],
    ],
    ["a side conversation", conversation({ source: { sideConversation: true } as never }), []],
    ["an archived conversation", conversation({ archived: true }), []],
  ])("refuses with %s", (_label, input, requests) => {
    expect(canEditCodexConversationUserTurns(input, requests)).toBe(false);
  });
});
