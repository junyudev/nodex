import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { flushPendingAccepts } from "@/lib/page-accept-undo";
import { pageTurnPhrase } from "@/lib/page-turn-phrase";
import type { PageTurn } from "../../../../../shared/page-turn";
import { createTestNodexReferenceRouter } from "@/test/nodex-reference-router";
import { ComposerReviewRail } from "./composer-review-rail";

const acceptPageWork = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/page-turn-runtime", () => ({ acceptPageWork }));

const turn: PageTurn = {
  page_id: "page-login",
  actor: { kind: "members" },
  reason: "review",
  since: "2026-01-01T00:00:00.000Z",
  episode: "episode-review",
  hold: null,
};

function renderReview() {
  const { open, wrap } = createTestNodexReferenceRouter();
  render(
    <NodexTooltipProvider delay={0}>
      {wrap(
        <ComposerReviewRail
          review={{
            turn,
            phrase: pageTurnPhrase(turn, { you: true, name: "" })!,
            page: { pageId: "page-login", pageKey: "WEB-1", title: "Fix login race", status: null },
          }}
          placement="attached"
        />,
        { surface: "conversation", sessionId: "chat-1" },
      )}
    </NodexTooltipProvider>,
  );
  return open;
}

describe("ComposerReviewRail", () => {
  afterEach(() => {
    flushPendingAccepts();
    acceptPageWork.mockClear();
  });

  it("names the work ready for review and opens its Page", async () => {
    const openPage = renderReview();
    expect(screen.getByText("Ready for your review")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "WEB-1 Fix login race" }));
      await Promise.resolve();
    });
    expect(openPage).toHaveBeenCalledExactlyOnceWith(
      { kind: "page", pageId: "page-login" },
      expect.objectContaining({
        source: { surface: "conversation", sessionId: "chat-1" },
        titleSnapshot: "Fix login race",
      }),
    );
  });

  it("accepts the episode the reader is looking at once its Undo window passes", async () => {
    renderReview();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      await Promise.resolve();
    });
    expect(acceptPageWork).not.toHaveBeenCalled();
    await act(async () => {
      flushPendingAccepts();
      await Promise.resolve();
    });
    expect(acceptPageWork).toHaveBeenCalledExactlyOnceWith("page-login", "episode-review");
  });
});
