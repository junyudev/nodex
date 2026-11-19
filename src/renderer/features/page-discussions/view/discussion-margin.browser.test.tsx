import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { DiscussionView } from "../discussion-view-model";
import { DiscussionMargin } from "./discussion-margin";

const discussion: DiscussionView = {
  id: "discussion-1",
  anchor: { kind: "page" },
  orphaned: false,
  quote: "",
  resolved: false,
  comments: [],
  waiting: null,
  latestAsk: null,
  offerAskNodex: false,
  canResolve: true,
  lastActivityMs: 0,
};

test("a pressed control acts on its own, and tabbing into a card opens it", async () => {
  const onActiveChange = vi.fn();
  const onAccept = vi.fn();
  render(
    <>
      <button type="button">Before</button>
      <div style={{ position: "relative", width: 80 }}>
        <DiscussionMargin
          mode="cards"
          discussions={[discussion]}
          anchorTops={new Map([[discussion.id, 0]])}
          activeId={null}
          onActiveChange={onActiveChange}
          renderCard={() => (
            <button type="button" onClick={onAccept}>
              Accept
            </button>
          )}
        />
      </div>
    </>,
  );
  const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  // The margin measures its cards after they render.
  await act(settle);

  // Opening the card on the press would re-lay out the margin before the click lands.
  await act(async () => {
    await userEvent.click(page.getByRole("button", { name: "Accept" }));
    await settle();
  });
  expect(onAccept).toHaveBeenCalledTimes(1);
  expect(onActiveChange).not.toHaveBeenCalled();

  await act(async () => {
    await userEvent.click(page.getByRole("button", { name: "Before" }));
    await userEvent.tab();
    await settle();
  });
  expect(onActiveChange).toHaveBeenCalledWith(discussion.id);
});
