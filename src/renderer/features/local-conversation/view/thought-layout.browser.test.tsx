import { waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { NodexTooltipProvider } from "../../../components/ui/tooltip";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import { renderWithMaitai } from "../../../test/thread-maitai";
import { ThreadLiveActivityFallback } from "./local-conversation-thread-turn";
import { LocalConversationTurnEntry } from "./local-conversation-turn-entry";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import "../../../globals.css";

const THREAD_WIDTH = 320;
const longProse = `I need to check whether the status label stays on one line. ${"The group header renders the summary inside an inline span. ".repeat(80)}`;

function item(itemId: string, overrides: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId,
    type: "reasoning",
    kind: "reasoning",
    semanticKind: "reasoning",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function renderStreamingTurn(thought: CodexConversationItem) {
  const turn: CodexConversationTurn = {
    threadId: "thread_1",
    turnId: "turn_1",
    status: "inProgress",
    itemIds: ["user", thought.itemId],
    items: [
      item("user", {
        type: "user_message",
        kind: "userMessage",
        semanticKind: "userMessage",
        role: "user",
        markdownText: "Fix the label",
      }),
      thought,
    ],
  };
  return renderWithMaitai(
    createElement(
      "div",
      { style: { width: THREAD_WIDTH } },
      createElement(
        NodexTooltipProvider,
        null,
        createElement(LocalConversationTurnEntry, {
          conversationId: "thread_1",
          entry: {
            turn,
            turnId: turn.turnId,
            turnKey: "turn_1",
            turnSearchKey: "turn_1",
            requests: [],
            isMostRecentTurn: true,
          },
          cwd: "/tmp/project",
          canEditTurnUserPrefix: false,
          canForkTurn: false,
        }),
      ),
    ),
    { wrapper: LocalConversationTestQueryProvider },
  );
}

function expectOneLineWithin(element: HTMLElement, frame: HTMLElement) {
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  const box = element.getBoundingClientRect();
  expect(box.height).toBeLessThan(lineHeight * 1.5);
  expect(box.right).toBeLessThanOrEqual(frame.getBoundingClientRect().right + 0.5);
}

const originalApi = window.api;
beforeEach(() => {
  window.api = {
    on: () => () => {},
    invoke: async (channel) =>
      channel === "persisted-atom:sync-request" ? { revision: 0, values: {} } : undefined,
  };
});
afterEach(() => {
  window.api = originalApi;
});

describe("Thought layout", () => {
  test("a long thinking status stays one truncated line inside the Thread", () => {
    const view = renderWithMaitai(
      createElement(
        "div",
        { style: { width: THREAD_WIDTH }, "data-testid": "frame" },
        createElement(ThreadLiveActivityFallback, { message: longProse }),
      ),
    );
    const status = view.container.querySelector<HTMLElement>("[data-codex-shimmer]");
    if (!status) throw new Error("expected the thinking status");
    expectOneLineWithin(status, view.getByTestId("frame"));
    expect(status.scrollWidth).toBeGreaterThan(status.clientWidth);
  });

  test("a long heading stays one line in a thinking group header", async () => {
    const heading = `Checking ${"the reducer and its projections ".repeat(30)}`;
    const view = renderStreamingTurn(
      item("thought", { status: "inProgress", markdownText: `**${heading}**` }),
    );
    const header = await view.findByRole("button", { name: heading.trim() });
    expectOneLineWithin(header, view.container.firstElementChild as HTMLElement);
  });

  test("streaming prose stays within a few lines under the Thinking status", async () => {
    const view = renderStreamingTurn(
      item("thought", { status: "inProgress", markdownText: longProse }),
    );
    const header = await view.findByRole("button", { name: "Thinking" });
    expectOneLineWithin(header, view.container.firstElementChild as HTMLElement);
    const preview = view.getByTestId("thought-live-preview");
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    await waitFor(() => expect(preview.getBoundingClientRect().height).toBeGreaterThan(0));
    await waitFor(() =>
      expect(preview.getBoundingClientRect().height).toBeLessThanOrEqual(rootFontSize * 5),
    );
    expect(preview.textContent).toContain("I need to check whether the status label");
  });
});
