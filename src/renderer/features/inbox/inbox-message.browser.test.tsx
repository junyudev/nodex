import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { PageChatActivitySummary } from "@/lib/types";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import { inboxNewChatAction, type InboxItem, type InboxProposal } from "../../../shared/inbox";
import { InboxMessage } from "./inbox-message";
import { InboxStreamItem } from "./inbox-stream-item";
import { inboxAgentsFixture } from "./inbox-agents.test-support";
import { InboxTriage } from "./inbox-triage";
import type { InboxActions } from "./use-inbox-actions";

installRendererThemeFixture();

const waiting: InboxItem = {
  pageId: "page:1",
  outcome: null,
  basis: { pageId: "page:1", contentHash: "content:1" },
  pageKey: "IN-1",
  pageStatus: null,
  title: "Homepage positioning",
  body: "Homepage feels like a dev tool",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-10-11T10:00:00.000Z",
  source: { kind: "user" },
  kind: null,
  important: false,
  state: "open",
  suggestionState: "pending",
  suggestionError: null,
  firing: null,
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
  linkedChats = null,
  onOpenPage = openNothing,
}: {
  item: InboxItem;
  selected?: boolean;
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
        awaitingIndicator
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

test("the waiting spinner ends where the bubble's bottom-right corner curve ends", () => {
  render(
    <Stream>
      <StreamMessage key="page:1" item={waiting} />
    </Stream>,
  );
  const corner = cornerEnd();
  const spinner = screen
    .getByRole("status", { name: "Finding where this goes" })
    .getBoundingClientRect();
  expect(spinner.top).toBeGreaterThanOrEqual(corner.bubble.bottom);
  expect(spinner.right).toBeCloseTo(corner.x, 0);
});

test("a row of icons ends its last glyph where the bubble's corner curve ends", () => {
  const failed = {
    ...waiting,
    suggestionState: "failed" as const,
    suggestionError: "Agent operation could not be completed",
  };
  render(
    <Stream>
      <StreamMessage key="page:1" item={failed} />
    </Stream>,
  );
  const corner = cornerEnd();
  const buttons = screen.getByTestId("inbox-actions").querySelectorAll("button");
  const lastGlyph = buttons[buttons.length - 1]!.querySelector("svg")!.getBoundingClientRect();
  expect(Math.abs(lastGlyph.right - corner.x)).toBeLessThanOrEqual(1);
});

test("a selected card's ring is never clipped, and only a message folding away clips", async () => {
  const view = render(
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

test("Copy and Edit wait on the text's bottom-right corner until the message is hovered", async () => {
  render(
    <Stream>
      <StreamMessage key="page:1" item={waiting} />
    </Stream>,
  );
  const tools = screen.getByTestId("inbox-message-actions");
  expect(Array.from(tools.querySelectorAll("button"), (button) => button.ariaLabel)).toEqual([
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
  render(
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
  render(
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
    const view = render(
      <Stream>
        <StreamMessage key={item.pageId} item={item} />
      </Stream>,
    );
    const bubble = screen.getByTestId("inbox-message-unit").getBoundingClientRect();
    // Hidden until a lingering hover, it still holds its place.
    const time = screen.getByLabelText("Open page").getBoundingClientRect();
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
    runtimeSessionIds: [],
  };
  const body =
    "Keep the drag handle visible while moving a block, and keep it in place when the pointer leaves the row during a long drag.";
  render(
    <Stream>
      <StreamMessage
        key="page:1"
        item={{ ...waiting, body, important: true, pageStatus: { id: "build", label: "Build" } }}
        linkedChats={chats}
      />
    </Stream>,
  );
  const marks = screen.getByTestId("inbox-page-marks");
  const status = screen.getByRole("img", { name: "Status: Build" }).getBoundingClientRect();
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
  render(
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
          runtimeSessionIds: [],
        }}
      />
    </Stream>,
  );
  expect(screen.getByRole("img", { name: "Status: Review" })).toBeTruthy();
  expect(textLines(screen.getByText(body))).toHaveLength(1);
});

test("a message still waiting in Triage with no chats shows no marks", () => {
  render(
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
          runtimeSessionIds: [],
        }}
      />
    </Stream>,
  );
  expect(screen.queryByTestId("inbox-page-marks")).toBeNull();
});

test("the time becomes the message's link to its Page once it shows", async () => {
  const onOpenPage = vi.fn();
  render(
    <Stream>
      <StreamMessage key="page:1" item={waiting} onOpenPage={onOpenPage} />
    </Stream>,
  );
  // Hidden, it cannot be chosen by accident and is not announced.
  expect(screen.queryByRole("button", { name: "Open page" })).toBeNull();
  const time = screen.getByLabelText("Open page");
  expect(getComputedStyle(time).visibility).toBe("hidden");
  await act(async () => {
    await userEvent.hover(screen.getByText("Homepage feels like a dev tool"));
  });
  await expect.poll(() => getComputedStyle(time).visibility, { timeout: 3_000 }).toBe("visible");
  await act(async () => {
    await userEvent.click(screen.getByRole("button", { name: "Open page" }));
  });
  expect(onOpenPage).toHaveBeenCalledOnce();
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
  render(
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
  expect(await screen.findByText("整理合并前的提交历史", {}, { timeout: 3_000 })).toBeTruthy();
  expect(screen.getByText("A clear task for a new chat.")).toBeTruthy();
  // What the chat runs on is never confused with the Agent that wrote the suggestion.
  expect(screen.getByText("Codex · GPT-6 Astra · Medium")).toBeTruthy();
  expect(screen.getByText("Suggested by Codex · GPT-6.1 Sol")).toBeTruthy();
});
