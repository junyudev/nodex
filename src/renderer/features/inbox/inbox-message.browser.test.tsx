import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vite-plus/test";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import type { InboxItem } from "../../../shared/inbox";
import { InboxMessage } from "./inbox-message";
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

test("the waiting spinner ends where the bubble's bottom-right corner curve ends", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NodexTooltipProvider>
        <div style={{ width: 640, padding: 24 }}>
          <InboxTriage
            item={waiting}
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
                item={waiting}
                selected={false}
                selectionActive={false}
                onToggleSelected={vi.fn()}
                onOpenSource={vi.fn()}
                editor={triage.editor}
                strip={triage.strip}
                actions={triage.actions}
              />
            )}
          </InboxTriage>
        </div>
      </NodexTooltipProvider>
    </QueryClientProvider>,
  );

  const bubble = screen.getByTestId("inbox-message-unit");
  const spinner = screen.getByRole("status", { name: "Finding where this goes" });
  const radius = Number.parseFloat(getComputedStyle(bubble).borderBottomRightRadius);
  const bubbleBox = bubble.getBoundingClientRect();
  const spinnerBox = spinner.getBoundingClientRect();

  expect(radius).toBeGreaterThan(0);
  expect(spinnerBox.top).toBeGreaterThanOrEqual(bubbleBox.bottom);
  expect(spinnerBox.right).toBeCloseTo(bubbleBox.right - radius, 0);
});
