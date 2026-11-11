import { act, render, screen, waitFor } from "@testing-library/react";
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
  render(
    <div style={{ width: 420 }}>
      <InboxTurnRow item={{ ...turnRow("review"), body }} {...turnRowHandlers()} />
    </div>,
  );

test("a report longer than its excerpt opens in place and closes again", async () => {
  renderRow(REPORT);
  const more = await screen.findByRole("button", { name: "Show more" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();

  await act(async () => {
    await userEvent.click(more);
  });
  // The whole report, read as it was written.
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText(/the closing words are here/u)).toBeTruthy();

  await act(async () => {
    await userEvent.click(screen.getByRole("button", { name: "Show less" }));
  });
  await waitFor(() => expect(screen.queryByRole("list")).toBeNull());
  expect(await screen.findByRole("button", { name: "Show more" })).toBeTruthy();
});

test("a report that fits its excerpt offers nothing to open", async () => {
  renderRow("Work is ready to review.");
  expect(screen.getByText("Work is ready to review.")).toBeTruthy();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});
