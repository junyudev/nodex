import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vite-plus/test";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import type { InboxItem } from "../../../shared/inbox";
import { InboxMessage } from "./inbox-message";
import { InboxStreamItem } from "./inbox-stream-item";
import { InboxTriage } from "./inbox-triage";
import type { InboxActions } from "./use-inbox-actions";

installRendererThemeFixture();

const waiting: InboxItem = {
  pageId: "page:1",
  outcome: null,
  basis: { pageId: "page:1", generation: 1, headSeq: 1, placementRevision: 1 },
  pageKey: "IN-1",
  title: "Homepage positioning",
  body: "Homepage feels like a dev tool",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-10-11T10:00:00.000Z",
  source: { kind: "user" },
  kind: null,
  state: "open",
  suggestionState: "pending",
  suggestionError: null,
  scope: { kind: "library" },
  location: { kind: "inbox" },
  proposal: null,
  revision: 1,
};

const actions = new Proxy({} as InboxActions, { get: () => vi.fn(async () => true) });

/** A message as the stream shows it: its triage around the card, in a stream item. */
function StreamMessage({ item, selected = false }: { item: InboxItem; selected?: boolean }) {
  return (
    <InboxStreamItem>
      <InboxTriage
        item={item}
        projects={[]}
        suggestionsEnabled
        awaitingIndicator
        actions={actions}
        manualDraft={null}
        groupedWithKey={null}
        inboxProjectId={null}
        menu={null}
        onManualDraftChange={vi.fn()}
        onEditAsPage={vi.fn()}
      >
        {(triage) => (
          <InboxMessage
            item={item}
            selected={selected}
            selectionActive={selected}
            onToggleSelected={vi.fn()}
            onOpenSource={vi.fn()}
            editor={triage.editor}
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
