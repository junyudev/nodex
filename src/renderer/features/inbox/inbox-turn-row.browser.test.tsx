import { act, screen, waitFor } from "@testing-library/react";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "@/globals.css";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import { InboxTurnRow } from "./inbox-turn-row";
import { turnRow, turnRowHandlers } from "./inbox-turn-row.test-support";

vi.mock("@/lib/space-host-runtime", () => ({ useSpaceHostAvailable: () => true }));
vi.mock("@/lib/use-library-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/use-library-navigation")>()),
  useLibraryFileReadAuthority: () => null,
}));

installRendererThemeFixture();

const REPORT = [
  "**Root cause.** The composer was removed whenever a started chat was reconnecting.",
  "",
  "- Kept the composer in place while the chat reconnects",
  "- Named what holds the next message",
  "",
  "Checks: renderer suite and the reconnect scenario pass, and the closing words are here.",
].join("\n");

const renderRow = (body: string) =>
  renderWithAppMaitai(
    <div style={{ width: 420 }}>
      <InboxTurnRow item={{ ...turnRow("review"), body }} {...turnRowHandlers()} />
    </div>,
  );

/** Whether the brief's three lines end above this part of the text. */
const clippedOut = (element: HTMLElement) => {
  const excerpt = element.closest("[data-brief-excerpt]");
  return (
    excerpt != null &&
    element.getBoundingClientRect().top >= excerpt.getBoundingClientRect().bottom - 1
  );
};

test("a report longer than its excerpt opens in place and closes again", async () => {
  renderRow(REPORT);
  const more = await screen.findByRole("button", { name: "Show more" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  const closing = () => screen.getByText(/the closing words are here/u);
  // Three lines of the report as written, its list included, then the clamp.
  expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  expect(clippedOut(closing())).toBe(true);

  await act(async () => {
    await userEvent.click(more);
  });
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(clippedOut(closing())).toBe(false);

  await act(async () => {
    await userEvent.click(screen.getByRole("button", { name: "Show less" }));
  });
  await waitFor(() => expect(clippedOut(closing())).toBe(true));
  expect(await screen.findByRole("button", { name: "Show more" })).toBeTruthy();
});

test("a brief ends a sentence it cuts with an ellipsis, and stops at the edge of a paragraph it finishes", async () => {
  const excerpt = () => document.querySelector<HTMLElement>("[data-brief-excerpt]")!;
  const { unmount } = renderRow(
    "One line.\n\nAnother line.\n\nA third line.\n\nThe fourth paragraph stays out of view.",
  );
  // The third line finishes its paragraph: no ellipsis after the full stop, only that edge.
  await waitFor(() => expect(getComputedStyle(excerpt()).webkitLineClamp).toBe("none"));
  expect(screen.getByText("A third line.").getBoundingClientRect().bottom).toBeLessThanOrEqual(
    excerpt().getBoundingClientRect().bottom + 0.5,
  );
  expect(clippedOut(screen.getByText(/fourth paragraph/u))).toBe(true);
  unmount();

  renderRow(Array(12).fill("A sentence that keeps running on").join(", ") + ".");
  await screen.findByRole("button", { name: "Show more" });
  expect(getComputedStyle(excerpt()).webkitLineClamp).toBe("3");
});

test("an excerpt stops before a code block, which opening reveals", async () => {
  renderRow("Run the check:\n\n```sh\nvp run check:changed\n```");
  expect(screen.getByText("Run the check:")).toBeTruthy();
  expect(screen.queryByText("vp run check:changed")).toBeNull();
  const more = await screen.findByRole("button", { name: "Show more" });
  await act(async () => {
    await userEvent.click(more);
  });
  expect(screen.getByText("vp run check:changed")).toBeTruthy();
});

test("a report that fits its excerpt offers nothing to open", async () => {
  renderRow("Work is ready to review.");
  expect(screen.getByText("Work is ready to review.")).toBeTruthy();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});
