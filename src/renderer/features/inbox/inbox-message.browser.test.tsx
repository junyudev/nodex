import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { expect, test, vi, describe } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { PageChatActivitySummary } from "@/lib/types";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import {
  inboxNewChatAction,
  type InboxItem,
  type InboxProposal,
  type InboxImportantMessage,
} from "../../../shared/inbox";
import { InboxMessage } from "./inbox-message";
import { formatInboxTime, type InboxOutcome, inboxBuriedImportant } from "./inbox-presentation";
import { InboxStreamItem } from "./inbox-stream-item";
import { inboxAgentsFixture } from "./inbox-agents.test-support";
import { InboxTriage } from "./inbox-triage";
import type { InboxActions } from "./use-inbox-actions";
import { InboxImportantBar } from "./inbox-important";
import { useInboxJump, useInboxMessagesInView } from "./use-inbox-important";
import type { InboxView } from "./inbox-viewport";
import { initiallyFollowsInbox, useInboxViewport } from "./use-inbox-viewport";

describe("inbox message", () => {
  installRendererThemeFixture();

  const waiting: InboxItem = {
    pageId: "page:1",
    rowKind: "intake",
    snooze: null,
    turn: null,
    basis: { pageId: "page:1", contentHash: "content:1" },
    pageKey: "IN-1",
    pageStatus: null,
    title: "Homepage positioning",
    titleProvisional: false,
    body: "Homepage feels like a dev tool",
    bodyTruncated: false,
    bodyEditable: true,
    submittedAt: "2026-10-11T10:00:00.000Z",
    source: { kind: "user" },
    replyToPageId: null,
    kind: null,
    important: false,
    waiting: true,
    suggestionState: "pending",
    suggestionError: null,
    automationDecision: null,
    scope: { kind: "library" },
    location: { kind: "inbox" },
    proposal: null,
    revision: 1,
  };

  const openNothing = () => undefined;

  const actions = new Proxy({} as InboxActions, { get: () => vi.fn(async () => true) });

  /** A message as the stream shows it: its triage around the card, in a stream item. */
  function StreamMessage({
    item,
    selected = false,
    decided = null,
    linkedChats = null,
    onOpenPage = openNothing,
  }: {
    item: InboxItem;
    selected?: boolean;
    decided?: InboxOutcome | null;
    linkedChats?: PageChatActivitySummary | null;
    onOpenPage?: () => void;
  }) {
    return (
      <InboxStreamItem>
        <InboxTriage
          item={item}
          projects={[]}
          agents={inboxAgentsFixture()}
          policy={{ kind: "automatic" }}
          decided={decided}
          onOpenSession={vi.fn()}
          actions={actions}
          manualDraft={null}
          groupedWithKey={null}
          inboxProjectId={null}
          menu={() => null}
          onManualDraftChange={vi.fn()}
        >
          {(triage) => (
            <InboxMessage
              item={item}
              selected={selected}
              selectionActive={selected}
              onToggleSelected={vi.fn()}
              linkedChats={linkedChats}
              onOpenChat={vi.fn()}
              onOpenPage={onOpenPage}
              onUnmarkImportant={vi.fn()}
              editor={triage.editor}
              messageActions={triage.messageActions}
              strip={triage.strip}
              actions={triage.actions}
            />
          )}
        </InboxTriage>
      </InboxStreamItem>
    );
  }

  const Stream = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <NodexTooltipProvider>
        <div data-testid="stream" style={{ width: 640, padding: 24 }}>
          <AnimatePresence initial={false}>{children}</AnimatePresence>
        </div>
      </NodexTooltipProvider>
    </QueryClientProvider>
  );

  /** Where the bubble's bottom-right corner curve meets its bottom edge. */
  const cornerEnd = () => {
    const bubble = screen.getByTestId("inbox-message-unit");
    const radius = Number.parseFloat(getComputedStyle(bubble).borderBottomRightRadius);
    expect(radius).toBeGreaterThan(0);
    return {
      bubble: bubble.getBoundingClientRect(),
      x: bubble.getBoundingClientRect().right - radius,
    };
  };

  /** ResizeObserver queues the message's overflow measurement for the following frame. */
  async function settleMessageLayout() {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
  }

  test("the waiting spinner becomes Stop in place, ending where the bubble's corner curve ends", async () => {
    renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={waiting} />
      </Stream>,
    );
    await settleMessageLayout();
    const stop = screen.getByRole("button", { name: "Stop suggesting" });
    expect(stop.getBoundingClientRect().top).toBeGreaterThanOrEqual(cornerEnd().bubble.bottom);
    const spinner = stop.querySelector("[data-activity-spinner]")!;
    const square = stop.querySelector(":scope > svg")!;
    expect(getComputedStyle(spinner).display).not.toBe("none");
    expect(getComputedStyle(square).display).toBe("none");

    await act(async () => {
      await userEvent.hover(stop);
      // Its tooltip opens and positions itself over the frames that follow.
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await expect.poll(() => getComputedStyle(square).display).toBe("block");
    expect(getComputedStyle(spinner).display).toBe("none");
    // Only the still square can be measured: a spinning glyph's bounds change as it turns. Hovering
    // scrolls the target into view, so the corner is read after it.
    expect(Math.abs(square.getBoundingClientRect().right - cornerEnd().x)).toBeLessThanOrEqual(1);

    // The pointer outlives this test, and would hover whatever the next one renders here.
    await act(async () => {
      await userEvent.unhover(stop);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });

  test("every message waiting for advice shows its own spinner", async () => {
    const another: InboxItem = {
      ...waiting,
      pageId: "page:2",
      basis: { pageId: "page:2", contentHash: "content:2" },
      pageKey: "IN-2",
    };
    renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={waiting} />
        <StreamMessage key="page:2" item={another} />
      </Stream>,
    );
    await settleMessageLayout();
    expect(screen.getAllByRole("status", { name: "Finding where this goes" })).toHaveLength(2);
  });

  test("a row of icons ends its last glyph where the bubble's corner curve ends", async () => {
    renderWithAppMaitai(
      <Stream>
        <StreamMessage
          key="page:1"
          item={waiting}
          decided={{
            icon: "chat",
            label: "Sent to a new chat",
            status: null,
            open: { kind: "session", sessionId: "session:1" },
            canReturn: false,
            done: null,
            inProgress: true,
          }}
        />
      </Stream>,
    );
    await settleMessageLayout();
    expect(screen.queryByRole("status", { name: "Finding where this goes" })).toBeNull();
    const corner = cornerEnd();
    const buttons = screen.getByTestId("inbox-actions").querySelectorAll("button");
    const lastGlyph = buttons[buttons.length - 1]!.querySelector("svg")!.getBoundingClientRect();
    expect(Math.abs(lastGlyph.right - corner.x)).toBeLessThanOrEqual(1);
  });

  test("a failed suggestion's Retry decision ends flush with the card's right edge", async () => {
    const failed = {
      ...waiting,
      suggestionState: "failed" as const,
      suggestionError: "Agent operation could not be completed",
    };
    renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={failed} />
      </Stream>,
    );
    await settleMessageLayout();
    const card = screen.getByTestId("inbox-message-unit").getBoundingClientRect();
    const retry = screen.getByRole("button", { name: "Retry" }).getBoundingClientRect();
    expect(Math.abs(retry.right - card.right)).toBeLessThanOrEqual(1);
  });

  test("a selected card's ring is never clipped, and only a message folding away clips", async () => {
    const view = renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={waiting} selected />
      </Stream>,
    );
    const stream = screen.getByTestId("stream");
    const card = screen.getByTestId("inbox-message-unit");
    expect(getComputedStyle(card).outlineStyle).not.toBe("none");
    // The ring reaches past the card's edge, so nothing between it and the stream may clip.
    for (let node = card.parentElement; node && node !== stream; node = node.parentElement) {
      const style = getComputedStyle(node);
      expect([style.overflowX, style.overflowY], node.className).toEqual(["visible", "visible"]);
    }

    const item = stream.firstElementChild as HTMLElement;
    await act(async () => {
      view.rerender(<Stream>{null}</Stream>);
      await Promise.resolve();
    });
    expect(item.isConnected).toBe(true);
    expect(getComputedStyle(item).overflowY).toBe("hidden");
  });

  test("Open page, Copy and Edit wait on the text's bottom-right corner until the message is hovered", async () => {
    renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={waiting} />
      </Stream>,
    );
    const tools = screen.getByTestId("inbox-message-actions");
    expect(Array.from(tools.querySelectorAll("button"), (button) => button.ariaLabel)).toEqual([
      "Open page",
      "Copy",
      "Edit",
    ]);
    const text = tools.parentElement!.getBoundingClientRect();
    const box = tools.getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(text.right);
    expect(box.bottom).toBeLessThanOrEqual(text.bottom);
    expect(text.right - box.right).toBeLessThan(box.width);
    expect(text.bottom - box.bottom).toBeLessThan(box.height);
    // Hidden, it leaves the text beneath it selectable.
    expect(getComputedStyle(tools).opacity).toBe("0");
    expect(getComputedStyle(tools).pointerEvents).toBe("none");

    await act(async () => {
      await userEvent.hover(screen.getByText("Homepage feels like a dev tool"));
    });
    await expect.poll(() => getComputedStyle(tools).opacity).toBe("1");
    expect(getComputedStyle(tools).pointerEvents).toBe("auto");
  });

  /** How visible an element is, through every faded ancestor within its message. */
  const shownOpacity = (element: Element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
      if (node.matches("[data-testid='inbox-message']")) break;
    }
    return opacity;
  };

  const overlaps = (a: DOMRect, b: DOMRect) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  test("an important message's star keeps its own place beside the bubble, through hover", async () => {
    renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={{ ...waiting, important: true }} />
      </Stream>,
    );
    const star = screen.getByRole("button", { name: "Unmark important" });
    const checkbox = screen.getByRole("checkbox", { name: "Select message" });
    const bubble = screen.getByTestId("inbox-message-unit").getBoundingClientRect();
    const glyph = star.querySelector("svg")!;
    // The user's bubble sits on the right: checkbox, then star, then bubble.
    const starBox = glyph.getBoundingClientRect();
    expect(starBox.right).toBeLessThanOrEqual(bubble.left);
    expect(checkbox.getBoundingClientRect().right).toBeLessThanOrEqual(starBox.left);
    expect(overlaps(starBox, checkbox.getBoundingClientRect())).toBe(false);
    // Level with the first line, as the checkbox is.
    expect(starBox.top + starBox.height / 2).toBeCloseTo(
      checkbox.getBoundingClientRect().top + checkbox.getBoundingClientRect().height / 2,
      0,
    );
    expect(shownOpacity(glyph)).toBe(1);
    expect(shownOpacity(checkbox)).toBe(0);

    await act(async () => {
      await userEvent.hover(screen.getByText("Homepage feels like a dev tool"));
    });
    await expect.poll(() => shownOpacity(checkbox)).toBe(1);
    expect(shownOpacity(glyph)).toBe(1);
  });

  test("a message without the mark has no star, even while hovered", async () => {
    renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={waiting} />
      </Stream>,
    );
    await act(async () => {
      await userEvent.hover(screen.getByText("Homepage feels like a dev tool"));
    });
    await expect.poll(() => shownOpacity(screen.getByRole("checkbox"))).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /important/ })).toBeNull();
  });

  test("the time keeps its place on the bubble's side whether or not the message is starred", () => {
    const timeOffset = (item: InboxItem) => {
      const view = renderWithAppMaitai(
        <Stream>
          <StreamMessage key={item.pageId} item={item} />
        </Stream>,
      );
      const bubble = screen.getByTestId("inbox-message-unit").getBoundingClientRect();
      // Hidden until a lingering hover, it still holds its place.
      const time = screen.getByText(formatInboxTime(item.submittedAt)).getBoundingClientRect();
      view.unmount();
      return bubble.left - time.right;
    };
    const plain = timeOffset(waiting);
    expect(plain).toBeGreaterThan(0);
    expect(timeOffset({ ...waiting, important: true })).toBeCloseTo(plain, 0);
  });

  /** Each line the text of a message lays out, top to bottom. */
  const textLines = (text: Element) => {
    const range = document.createRange();
    range.selectNodeContents(text);
    const lines: DOMRect[] = [];
    for (const rect of range.getClientRects()) {
      const line = lines.find((seen) => Math.abs(seen.top - rect.top) < 2);
      if (!line) lines.push(rect);
    }
    return lines.toSorted((a, b) => a.top - b.top);
  };

  test("a Page that has moved on opens its first line with its status and chats, and its text wraps beneath them", () => {
    const chats: PageChatActivitySummary = {
      pageId: "page:1",
      relatedCount: 1,
      workingCount: 1,
      waitingOnApprovalCount: 0,
      waitingOnUserInputCount: 0,
      errorCount: 0,
      unreadCount: 0,
      soleSessionId: "session:1",
      work: { activeChat: null, latestReport: null, managedSessionCount: 0 },
      runtimeSessionIds: [],
    };
    const body =
      "Keep the drag handle visible while moving a block, and keep it in place when the pointer leaves the row during a long drag.";
    renderWithAppMaitai(
      <Stream>
        <StreamMessage
          key="page:1"
          item={{ ...waiting, body, important: true, pageStatus: { id: "doing", label: "Doing" } }}
          linkedChats={chats}
        />
      </Stream>,
    );
    const marks = screen.getByTestId("inbox-page-marks");
    const status = screen.getByRole("img", { name: "Status: Doing" }).getBoundingClientRect();
    const chat = screen.getByRole("button", { name: /1 linked chat/ }).getBoundingClientRect();
    const lines = textLines(screen.getByText(body));
    const [first, next] = [lines[0]!, lines[1]!];
    // They belong to the message itself, inside its bubble, and stay shown.
    expect(screen.getByTestId("inbox-message-unit").contains(marks)).toBe(true);
    expect(shownOpacity(marks)).toBe(1);
    // Status, then the way to its chats, then the words, all on the first line.
    expect(chat.left).toBeGreaterThanOrEqual(status.right);
    expect(first.left).toBeGreaterThanOrEqual(chat.right);
    for (const mark of [status, chat]) {
      expect(Math.abs(mark.top + mark.height / 2 - (first.top + first.height / 2))).toBeLessThan(2);
    }
    // The rest of the message takes the bubble's full width again, starting where the marks do.
    expect(lines.length).toBeGreaterThan(1);
    expect(Math.abs(next.left - marks.getBoundingClientRect().left)).toBeLessThan(1);
  });

  test("marks never push a message that fits on one line onto a second", () => {
    const body = "Review the empty search results copy.";
    renderWithAppMaitai(
      <Stream>
        <StreamMessage
          key="page:1"
          item={{ ...waiting, body, pageStatus: { id: "review", label: "Review" } }}
          linkedChats={{
            pageId: "page:1",
            relatedCount: 2,
            workingCount: 0,
            waitingOnApprovalCount: 0,
            waitingOnUserInputCount: 1,
            errorCount: 0,
            unreadCount: 0,
            soleSessionId: null,
            work: { activeChat: null, latestReport: null, managedSessionCount: 0 },
            runtimeSessionIds: [],
          }}
        />
      </Stream>,
    );
    expect(screen.getByRole("img", { name: "Status: Review" })).toBeTruthy();
    expect(textLines(screen.getByText(body))).toHaveLength(1);
  });

  test("a message still waiting in Triage with no chats shows no marks", () => {
    renderWithAppMaitai(
      <Stream>
        <StreamMessage
          key="page:1"
          item={{ ...waiting, pageStatus: { id: "triage", label: "Triage" } }}
          linkedChats={{
            pageId: "page:1",
            relatedCount: 0,
            workingCount: 0,
            waitingOnApprovalCount: 0,
            waitingOnUserInputCount: 0,
            errorCount: 0,
            unreadCount: 0,
            soleSessionId: null,
            work: { activeChat: null, latestReport: null, managedSessionCount: 0 },
            runtimeSessionIds: [],
          }}
        />
      </Stream>,
    );
    expect(screen.queryByTestId("inbox-page-marks")).toBeNull();
  });

  test("the time becomes another link to the message's Page once it shows", async () => {
    const onOpenPage = vi.fn();
    renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={waiting} onOpenPage={onOpenPage} />
      </Stream>,
    );
    const shown = formatInboxTime(waiting.submittedAt);
    // Hidden, it cannot be chosen by accident and is not announced.
    expect(screen.queryByRole("button", { name: shown })).toBeNull();
    const time = screen.getByText(shown).closest("button")!;
    expect(getComputedStyle(time).visibility).toBe("hidden");
    await act(async () => {
      await userEvent.hover(screen.getByText("Homepage feels like a dev tool"));
    });
    await expect.poll(() => getComputedStyle(time).visibility).toBe("visible");
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: shown }));
    });
    expect(onOpenPage).toHaveBeenCalledOnce();
  });

  test("a message an Agent sent reads as a brief: its title, then three receding lines that open in place", async () => {
    const onOpenPage = vi.fn();
    const body = [
      "`landing-build.nightly.test.ts` fails on current main: changelog entries with media carry their caption and an inline script into the entry's text.",
      "",
      "**Evidence.** For the entry `changes/added/2026-11-26-custom-snooze-picker.md`, the received list differs from the expected one in two ways.",
      "",
      "- the entry's text runs on with its media caption",
      "- the entry sits one place earlier than expected",
      "",
      "Not verified: whether the feed is affected, and the closing words are here.",
    ].join("\n");
    const report: InboxItem = {
      ...waiting,
      title: "Changelog build test fails on media entries",
      body,
      bodyEditable: false,
      source: {
        kind: "agent",
        sessionId: "session:1",
        threadId: null,
        runId: null,
        projectId: null,
        label: "Landing refresh",
      },
    };
    const { rerender } = renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={report} onOpenPage={onOpenPage} />
      </Stream>,
    );
    await settleMessageLayout();
    const headline = screen.getByRole("heading", { name: report.title });
    const excerpt = screen.getByTestId("inbox-message-unit").querySelector("[data-brief-excerpt]")!;
    const closing = screen.getByText(/the closing words are here/u);
    // The headline leads at full strength; the opening recedes beneath it and stops at three lines.
    expect(headline.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      excerpt.getBoundingClientRect().top + 1,
    );
    expect(getComputedStyle(excerpt).color).not.toBe(getComputedStyle(headline).color);
    const lineHeight = Number.parseFloat(
      getComputedStyle(screen.getByText(/fails on current main/u)).lineHeight,
    );
    expect(excerpt.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight * 3 + 1);
    expect(closing.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      excerpt.getBoundingClientRect().bottom - 1,
    );

    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    });
    expect(
      screen.getByTestId("inbox-message-unit").querySelector("[data-brief-excerpt]"),
    ).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();

    // The headline is the way to read the whole message in its Page.
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: report.title }));
    });
    expect(onOpenPage).toHaveBeenCalledOnce();

    // A provisional title only repeats the opening words, so the brief opens with them instead.
    rerender(
      <Stream>
        <StreamMessage key="page:1" item={{ ...report, titleProvisional: true }} />
      </Stream>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText(/fails on current main/u)).toBeTruthy();
  });

  test("the reader's own message reads whole, with no headline", async () => {
    renderWithAppMaitai(
      <Stream>
        <StreamMessage key="page:1" item={waiting} />
      </Stream>,
    );
    await settleMessageLayout();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.getByText("Homepage feels like a dev tool")).toBeTruthy();
  });

  test("a chat suggestion reads as its prompt: full width, the message's size, why on the decision", async () => {
    const prompt =
      "整理当前尚未合并的 commits，使提交历史清晰、连贯、便于审阅，保留最终改动意图。完整要求见附带原文，并在整理前后各列出一次提交清单供对照。";
    const proposal: InboxProposal = {
      proposalId: "proposal:1",
      revision: 1,
      origin: "agent",
      state: "open",
      pageIds: ["page:1"],
      basis: [waiting.basis],
      outdated: false,
      explicitRequest: false,
      confirmedBy: null,
      action: inboxNewChatAction("project:nodex", prompt),
      kind: "todo",
      summary: "整理合并前的提交历史",
      rationale: "A clear task for a new chat.",
      producedBy: "Codex · GPT-6.1 Sol",
      targetProjectName: "Nodex",
      chat: null,
      failureMessage: null,
      failureKind: null,
      createdAt: "2026-10-11T10:00:00.000Z",
      updatedAt: "2026-10-11T10:00:00.000Z",
    };
    renderWithAppMaitai(
      <Stream>
        <StreamMessage
          key="page:1"
          item={{ ...waiting, kind: "todo", suggestionState: "settled", proposal }}
        />
      </Stream>,
    );
    const strip = screen.getByTestId("inbox-suggestion").getBoundingClientRect();
    const paragraph = screen.getByText(prompt);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const lines = Array.from(range.getClientRects());
    expect(lines.length).toBeGreaterThan(1);
    // Every line runs from the strip's own edge; nothing about the message's kind sits in it.
    for (const line of lines) expect(Math.abs(line.left - strip.left)).toBeLessThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /^Kind/ })).toBeNull();
    expect(getComputedStyle(paragraph).fontSize).toBe(
      getComputedStyle(screen.getByText("Homepage feels like a dev tool")).fontSize,
    );
    expect(screen.queryByText("整理合并前的提交历史")).toBeNull();

    await act(async () => {
      await userEvent.hover(screen.getByRole("button", { name: "New chat in Nodex" }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(await screen.findByText("整理合并前的提交历史")).toBeTruthy();
    expect(screen.getByText("A clear task for a new chat.")).toBeTruthy();
    // What the chat runs on is never confused with the Agent that wrote the suggestion.
    expect(screen.getByText("Codex · GPT-6 Astra · Medium")).toBeTruthy();
    expect(screen.getByText("Suggested by Codex · GPT-6.1 Sol")).toBeTruthy();
  });
});

describe("inbox important", () => {
  installRendererThemeFixture();

  const ROW_PX = 100;
  const VIEWPORT_PX = 300;
  const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");

  /** Newest first, as Core windows return them. */
  const messages = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ pageId: `m${count - index}` }) as InboxItem);

  const important = (...pageIds: string[]): InboxImportantMessage[] =>
    pageIds.map((pageId) => ({
      pageId,
      title: `Important ${pageId}`,
      submittedAt: "2026-10-16T12:00:00.000Z",
    }));

  const noMoreWindows = async () => undefined;

  /** The Inbox route's stream reduced to what pointing back to important messages depends on. */
  function Stream({
    items,
    marked,
    hasNextPage = false,
    fetchNextPage = noMoreWindows,
  }: {
    items: readonly InboxItem[];
    marked: readonly InboxImportantMessage[];
    hasNextPage?: boolean;
    fetchNextPage?: () => Promise<unknown>;
  }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);
    const inView = useInboxMessagesInView(
      scrollRef,
      marked.map((message) => message.pageId),
    );
    const jump = useInboxJump({
      scrollRef,
      stickToBottomRef,
      hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage,
    });
    // The Inbox opens at its newest messages, against the composer.
    useLayoutEffect(() => {
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }, []);
    return (
      <div style={{ position: "relative" }}>
        <InboxImportantBar
          buried={inboxBuriedImportant(marked, marked.length, inView)}
          nowMs={NOW_MS}
          onJump={jump.jump}
        />
        <div
          ref={scrollRef}
          data-testid="scroller"
          style={{ height: VIEWPORT_PX, overflowY: "auto" }}
        >
          {items.toReversed().map((item) => (
            <div key={item.pageId} data-inbox-page-id={item.pageId} style={{ height: ROW_PX }}>
              {item.pageId}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const scroller = () => screen.getByTestId("scroller");
  const bar = () => screen.queryByTestId("inbox-important-bar");
  const frames = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const settle = () =>
    act(async () => {
      await frames();
    });
  const inView = (pageId: string) => {
    const row = screen.getByText(pageId).getBoundingClientRect();
    const bounds = scroller().getBoundingClientRect();
    return row.bottom > bounds.top && row.top < bounds.bottom;
  };

  /** A computed color's alpha, whichever syntax the engine reports it in. */
  const alphaOf = (color: string) => {
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
    if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
    const rgba = /^rgba\((?:[^,]+,){3}\s*([\d.]+)\)$/.exec(color);
    return rgba ? Number(rgba[1]) : 1;
  };

  describe("important messages out of view", () => {
    test("are pointed back to only while they are out of view", async () => {
      renderWithAppMaitai(<Stream items={messages(20)} marked={important("m3")} />);
      await settle();
      expect(bar()?.textContent).toContain("Important m3");
      // It has waited four days.
      expect(bar()?.textContent).toContain("4d");

      await act(async () => {
        scroller().scrollTop = 0;
        await frames();
      });
      await waitFor(() => expect(bar()).toBeNull());
    });

    test("bring the reader back to the longest-waiting one, then point at the next", async () => {
      renderWithAppMaitai(<Stream items={messages(20)} marked={important("m2", "m14")} />);
      await settle();
      expect(bar()?.textContent).toContain("Important m2");
      expect(bar()?.textContent).toContain("1/2");

      await act(async () => {
        fireEvent.click(bar()!);
        await frames();
      });
      await waitFor(() => expect(inView("m2")).toBe(true));
      await waitFor(() => expect(bar()?.textContent).toContain("Important m14"));
      expect(bar()?.textContent).toContain("2/2");
    });

    test("load earlier windows to find one further back than the stream has loaded", async () => {
      const all = messages(20);
      const fetchNextPage = vi.fn(async () => undefined);
      const view = renderWithAppMaitai(
        <Stream
          items={all.slice(0, 10)}
          marked={important("m3")}
          hasNextPage
          fetchNextPage={fetchNextPage}
        />,
      );
      await settle();
      await act(async () => {
        fireEvent.click(bar()!);
        await frames();
      });
      expect(fetchNextPage).toHaveBeenCalledTimes(1);

      view.rerender(<Stream items={all} marked={important("m3")} fetchNextPage={fetchNextPage} />);
      await waitFor(() => expect(inView("m3")).toBe(true));
      await waitFor(() => expect(bar()).toBeNull());
    });
    test("are named on a surface that stays opaque under the pointer", async () => {
      renderWithAppMaitai(<Stream items={messages(20)} marked={important("m3")} />);
      await settle();
      await act(async () => {
        await userEvent.hover(bar()!);
      });
      const style = getComputedStyle(bar()!);
      // The hover tint is translucent, so it lies over the surface rather than replacing it.
      expect(alphaOf(style.backgroundColor)).toBe(1);
      expect(style.backgroundImage).toContain("gradient");
    });
  });
});

describe("inbox viewport", () => {
  const ROW_PX = 100;
  const VIEWPORT_PX = 300;

  /** Row identities newest first, as Core windows return them. */
  const messages = (count: number, prefix = "m") =>
    Array.from({ length: count }, (_, index) => `${prefix}${count - index}`);

  const fetchNoMorePages = async () => undefined;

  /** The Inbox route's stream reduced to what keeping a place depends on. */
  function Stream({
    scopeKey,
    items,
    view = "inbox",
    hasNextPage = false,
    fetchNextPage = fetchNoMorePages,
  }: {
    scopeKey: string;
    items: readonly string[];
    view?: InboxView;
    hasNextPage?: boolean;
    fetchNextPage?: () => Promise<unknown>;
  }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(initiallyFollowsInbox(scopeKey));
    const viewport = useInboxViewport({
      scopeKey,
      view,
      activityFilter: "all",
      scrollRef,
      stickToBottomRef,
      anchorIds: items,
      ready: true,
      hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage,
    });
    const ordered = view === "inbox" ? items.toReversed() : items;
    return (
      <div
        ref={scrollRef}
        data-testid="scroller"
        onScroll={viewport.onScroll}
        style={{ height: VIEWPORT_PX, overflowY: "auto" }}
      >
        {ordered.map((id) =>
          view === "inbox" ? (
            <div key={id} data-inbox-page-id={id} style={{ height: ROW_PX }}>
              {id}
            </div>
          ) : (
            <div key={id} data-activity-id={id} style={{ height: ROW_PX }}>
              {id}
            </div>
          ),
        )}
      </div>
    );
  }

  const scroller = () => screen.getByTestId("scroller");
  const frames = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const scrollTo = async (top: number) => {
    await act(async () => {
      scroller().scrollTop = top;
      await frames();
    });
  };
  const offsetOf = (pageId: string) =>
    screen.getByText(pageId).getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  const atBottom = () =>
    scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight <= 1;

  describe("an Inbox's place", () => {
    test("returns to the message the reader left at, though messages above it were handled", async () => {
      const items = messages(20);
      const first = renderWithAppMaitai(<Stream scopeKey="test:anchor" items={items} />);
      expect(atBottom()).toBe(true);
      await scrollTo(650);
      // Oldest first, m8 is the first message wholly in view, 50px below the top.
      expect(offsetOf("m8")).toBe(50);
      first.unmount();

      // Two older messages were handled while the reader was away.
      renderWithAppMaitai(
        <Stream scopeKey="test:anchor" items={items.filter((id) => !["m1", "m2"].includes(id))} />,
      );
      expect(offsetOf("m8")).toBe(50);
    });

    test("keeps following the newest messages when the reader left there", async () => {
      const first = renderWithAppMaitai(<Stream scopeKey="test:latest" items={messages(20)} />);
      expect(atBottom()).toBe(true);
      first.unmount();
      renderWithAppMaitai(<Stream scopeKey="test:latest" items={messages(25)} />);
      expect(atBottom()).toBe(true);
    });

    test("settles at the newest messages when the message it left at was handled", async () => {
      const items = messages(20);
      const first = renderWithAppMaitai(<Stream scopeKey="test:handled" items={items} />);
      await scrollTo(650);
      first.unmount();
      renderWithAppMaitai(
        <Stream scopeKey="test:handled" items={items.filter((id) => id !== "m8")} />,
      );
      expect(atBottom()).toBe(true);
    });

    test("keeps a place in each view", async () => {
      const items = messages(20);
      const view = renderWithAppMaitai(<Stream scopeKey="test:views" items={items} />);
      await scrollTo(650);
      view.rerender(<Stream scopeKey="test:views" items={items} view="activity" />);
      // Activity opens at its newest fact, at the top.
      expect(scroller().scrollTop).toBe(0);
      await scrollTo(420);
      view.rerender(<Stream scopeKey="test:views" items={items} />);
      expect(offsetOf("m8")).toBe(50);
      view.rerender(<Stream scopeKey="test:views" items={items} view="activity" />);
      expect(scroller().scrollTop).toBe(420);
    });

    test("loads earlier windows to find the message it left at", async () => {
      const all = messages(20);
      const first = renderWithAppMaitai(<Stream scopeKey="test:earlier" items={all} />);
      await scrollTo(150);
      // m3 is wholly in view first; only the newest ten messages load on return.
      expect(offsetOf("m3")).toBe(50);
      first.unmount();

      const fetchNextPage = vi.fn(async () => undefined);
      const view = renderWithAppMaitai(
        <Stream
          scopeKey="test:earlier"
          items={all.slice(0, 10)}
          hasNextPage
          fetchNextPage={fetchNextPage}
        />,
      );
      expect(fetchNextPage).toHaveBeenCalledTimes(1);
      view.rerender(<Stream scopeKey="test:earlier" items={all} fetchNextPage={fetchNextPage} />);
      expect(offsetOf("m3")).toBe(50);
    });
  });
});
