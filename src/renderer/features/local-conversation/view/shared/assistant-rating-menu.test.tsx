import { useState } from "react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AssistantRatingMenu } from "./assistant-rating-menu";
import type { AssistantMessageRating } from "./thread-message-actions";

function RatingHarness() {
  const [rating, setRating] = useState<AssistantMessageRating | null>(null);
  return <AssistantRatingMenu selectedRating={rating} onSelect={setRating} />;
}

afterEach(cleanup);

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

describe("response rating menu", () => {
  test.each(["good", "bad"])("selects and removes %s feedback through one action", async (kind) => {
    const view = render(<RatingHarness />);
    expect(view.queryByRole("menuitem")).toBeNull();
    await click(view.getByRole("button", { name: "Rate response" }));
    const item = await view.findByRole("menuitem", {
      name: kind === "good" ? "Good response" : "Bad response",
    });
    await click(item);
    const remove = await view.findByRole("button", { name: `Remove ${kind} response feedback` });
    expect(remove.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(remove);
    await click(remove);
    const trigger = await view.findByRole("button", { name: "Rate response" });
    expect(document.activeElement).toBe(trigger);
    await click(trigger);
    expect(await view.findByRole("menuitem", { name: "Good response" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Bad response" })).toBeTruthy();
  });

  test("Escape dismisses without rating and restores keyboard focus", async () => {
    const view = render(<RatingHarness />);
    const trigger = view.getByRole("button", { name: "Rate response" });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      await Promise.resolve();
    });
    await view.findByRole("menu");
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
