import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationSnapshot, CodexConversationTurn } from "../../../lib/types";
import {
  buildThreadSummaryPanelSessionSideChatRows,
  buildThreadSummaryPanelSideChatRow,
  isThreadSummarySideChatResponseInProgress,
} from "./thread-summary-panel-side-chat-row-model";

function makeConversation(
  overrides: Partial<
    Pick<CodexConversationSnapshot, "statusType" | "statusActiveFlags" | "turns">
  > = {},
): Pick<CodexConversationSnapshot, "statusType" | "statusActiveFlags" | "turns"> {
  return {
    statusType: "idle",
    statusActiveFlags: [],
    turns: [],
    ...overrides,
  } as Pick<CodexConversationSnapshot, "statusType" | "statusActiveFlags" | "turns">;
}

describe("buildThreadSummaryPanelSideChatRow", () => {
  test("projects the side-chat row identity and conversation response state", () => {
    const row = buildThreadSummaryPanelSideChatRow(
      {
        id: "sidechat:thread-side",
        title: "Investigate layout",
        threadId: "thread-side",
        panelId: "right",
        leafId: "leaf-a",
      },
      makeConversation({ statusType: "active" }),
    );

    expect(row.id).toBe("sidechat:thread-side");
    expect(row.title).toBe("Investigate layout");
    expect(row.isResponseInProgress).toBe(true);
    expect(row.panelId).toBe("right");
    expect(row.leafId).toBe("leaf-a");
  });

  test("does not treat a tab without a loaded conversation as response-in-progress", () => {
    const row = buildThreadSummaryPanelSideChatRow(
      {
        id: "sidechat-loading:thread-main:1",
        title: "Side chat",
        threadId: null,
        panelId: "bottom",
      },
      null,
    );

    expect(row.isResponseInProgress).toBe(false);
    expect(row.leafId).toBe(null);
  });
});

describe("isThreadSummarySideChatResponseInProgress", () => {
  test("uses conversation activity instead of panel-tab loading state", () => {
    const inProgressTurn = [
      {
        turnId: "turn-live",
        status: "inProgress",
        items: [],
      },
    ] as unknown as CodexConversationTurn[];

    expect(isThreadSummarySideChatResponseInProgress(null)).toBe(false);
    expect(isThreadSummarySideChatResponseInProgress(makeConversation())).toBe(false);
    expect(
      isThreadSummarySideChatResponseInProgress(makeConversation({ statusType: "active" })),
    ).toBe(true);
    expect(
      isThreadSummarySideChatResponseInProgress(
        makeConversation({ statusActiveFlags: ["waitingOnUserInput"] }),
      ),
    ).toBe(true);
    expect(
      isThreadSummarySideChatResponseInProgress(makeConversation({ turns: inProgressTurn })),
    ).toBe(true);
  });
});

describe("buildThreadSummaryPanelSessionSideChatRows", () => {
  test("lists every side chat newest first, placing the open ones in their tabs", () => {
    const rows = buildThreadSummaryPanelSessionSideChatRows({
      open: [
        { sessionId: "older", title: "Renamed by its request", panelId: "bottom", leafId: "b" },
        { sessionId: "new", title: "Side chat 2", panelId: "right", leafId: "a" },
      ],
      listed: [
        { sessionId: "older", title: "Side chat" },
        { sessionId: "closed", title: "Closed question" },
      ],
      listComplete: true,
      isResponding: (sessionId) => sessionId === "closed",
    });
    expect(rows).toEqual([
      {
        id: "sidechat-session:new",
        title: "Side chat 2",
        isResponseInProgress: false,
        panelId: "right",
        leafId: "a",
      },
      {
        id: "sidechat-session:older",
        title: "Renamed by its request",
        isResponseInProgress: false,
        panelId: "bottom",
        leafId: "b",
      },
      {
        id: "sidechat-session:closed",
        title: "Closed question",
        isResponseInProgress: true,
        panelId: undefined,
        leafId: null,
      },
    ]);
  });

  test("keeps an open side chat the read has not reached after the listed ones", () => {
    const rows = buildThreadSummaryPanelSessionSideChatRows({
      open: [{ sessionId: "old-open", title: "Old question", panelId: "right", leafId: "a" }],
      listed: [{ sessionId: "newest", title: "Newest question" }],
      listComplete: false,
      isResponding: () => false,
    });
    expect(rows.map((row) => row.id)).toEqual([
      "sidechat-session:newest",
      "sidechat-session:old-open",
    ]);
  });
});
