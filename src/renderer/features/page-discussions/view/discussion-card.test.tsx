import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import type { DiscussionView } from "../discussion-view-model";
import { diffSuggestedEdit } from "../suggested-edit-diff";
import { DiscussionCard, type DiscussionCardActions } from "./discussion-card";

afterEach(cleanup);

const discussion: DiscussionView = {
  id: "discussion-1",
  anchor: { kind: "blocks", blockIds: ["block-1"] },
  orphaned: false,
  quote: "",
  resolved: false,
  waiting: null,
  latestAsk: null,
  offerAskNodex: false,
  canResolve: true,
  lastActivityMs: 0,
  comments: [
    {
      id: "comment-1",
      author: { kind: "member", memberId: "member-1", name: "Maya", isSelf: false },
      createdAtMs: 0,
      edited: false,
      deleted: false,
      bodyMarkdown: "Suggested edit",
      ask: null,
      verdict: null,
      asksSelf: false,
      canEdit: false,
      suggestedEdit: {
        state: "open",
        blockIds: ["block-1"],
        diff: diffSuggestedEdit("Usage doubled.", "Usage grew 2.4x."),
        oldMarkdown: "Usage doubled.",
        newMarkdown: "Usage grew 2.4x.",
        decidedBy: null,
        canAccept: true,
        canReject: true,
      },
    },
  ],
};

const actions = (): DiscussionCardActions => ({
  resolve: vi.fn(),
  reopen: vi.fn(),
  acceptSuggestedEdit: vi.fn(),
  rejectSuggestedEdit: vi.fn(),
  askNodex: vi.fn(),
  stopAsk: vi.fn(),
  retryAsk: vi.fn(),
  openConversation: vi.fn(),
  undoAsk: vi.fn(),
});

test("a control on an inactive card acts without activating the card first", async () => {
  const cardActions = actions();
  const onActivate = vi.fn();
  render(
    <DiscussionCard
      discussion={discussion}
      active={false}
      nowMs={0}
      actions={cardActions}
      composer={null}
      onActivate={onActivate}
    />,
  );

  const accept = screen.getByRole("button", { name: "Accept" });
  await act(async () => {
    fireEvent.pointerDown(accept);
    fireEvent.click(accept);
    await Promise.resolve();
  });
  expect(onActivate).not.toHaveBeenCalled();
  expect(cardActions.acceptSuggestedEdit).toHaveBeenCalledWith("comment-1");

  await act(async () => {
    fireEvent.pointerDown(screen.getByText("Maya"));
    await Promise.resolve();
  });
  expect(onActivate).toHaveBeenCalledTimes(1);
});
