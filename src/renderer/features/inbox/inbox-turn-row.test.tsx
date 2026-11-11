import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { render, openNodexMenu } from "@/test/dom";
import { InboxTurnRow } from "./inbox-turn-row";
import { turnRow as row, turnRowHandlers as props } from "./inbox-turn-row.test-support";
vi.mock("@/lib/space-host-runtime", () => ({ useSpaceHostAvailable: () => true }));
afterEach(cleanup);
test.each([
  ["approval", "Open chat"],
  ["review", "Accept"],
  ["blocked", "Open chat"],
  ["failed", "Open chat"],
  ["stalled", "Open chat"],
  ["ready_to_start", "Start"],
] as const)("offers the typed action for %s", async (reason, action) => {
  const handlers = props();
  render(<InboxTurnRow item={row(reason)} {...handlers} />);
  expect(screen.getByRole("button", { name: "Ship the change" })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: action }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(
      action === "Accept"
        ? handlers.onAccept
        : action === "Start"
          ? handlers.onStart
          : handlers.onOpenChat,
    ).toHaveBeenCalledOnce(),
  );
});
test("answers exact labels and puts only extra options in More", async () => {
  const handlers = props();
  render(
    <InboxTurnRow
      item={row("question", ["First", "Second", "Third", "Fourth", "Fifth"])}
      {...handlers}
    />,
  );
  expect(screen.getByText("The exact question or report")).toBeTruthy();
  expect(screen.queryByLabelText("Note from Nodex")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(handlers.onAnswer).toHaveBeenCalledWith("Second"));
  await openNodexMenu(screen.getByRole("button", { name: "More…" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Fifth" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(handlers.onAnswer).toHaveBeenCalledWith("Fifth"));
});
test.each(["review", "failed"] as const)(
  "explains undeliverable %s replies beside the current note",
  (reason) => {
    const item = row(reason);
    render(
      <InboxTurnRow
        item={{ ...item, turn: { ...item.turn!, note_id: "note", active_chat: null } }}
        {...props()}
      />,
    );
    expect(screen.getByLabelText("Note from Nodex")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open chat" })).toBeTruthy();
  },
);
test.each([
  ["question", ["Yes", "No"]],
  ["review", []],
] as const)("a %s turn that decides in place still opens its chat", async (reason, options) => {
  const handlers = props();
  render(<InboxTurnRow item={row(reason, [...options])} {...handlers} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await Promise.resolve();
  });
  expect(handlers.onOpenChat).toHaveBeenCalledOnce();
});
test("work that has not started has no chat to open", () => {
  render(<InboxTurnRow item={row("ready_to_start")} {...props()} />);
  expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
});
test.each([
  ["question", "Needs your answer"],
  ["approval", "Needs your approval"],
  ["review", "Ready for your review"],
  ["failed", "Failed · needs you"],
  ["ready_to_start", "Ready to start"],
] as const)("words a %s turn as the reader's own", (reason, phrase) => {
  render(<InboxTurnRow item={row(reason)} {...props()} />);
  expect(screen.getByText(phrase)).toBeTruthy();
});
test("a note from Nodex leads with its mark, not a label", () => {
  const item = row("review");
  render(
    <InboxTurnRow item={{ ...item, turn: { ...item.turn!, note_id: "note" } }} {...props()} />,
  );
  const mark = screen.getByRole("img", { name: "Note from Nodex" });
  expect(mark.querySelector("svg")?.getAttribute("data-nodex-logo-mark")).toBe("monochrome");
  expect(screen.queryByText(/Nodex note/u)).toBeNull();
});
test("a move that can wait is set aside until a chosen time", async () => {
  const handlers = props();
  render(<InboxTurnRow item={row("review")} {...handlers} />);
  await openNodexMenu(screen.getByRole("button", { name: "Later" }));
  const option = await screen.findByRole("menuitem", { name: "In 1 hour" });
  await act(async () => {
    fireEvent.click(option);
    await Promise.resolve();
  });
  const [until] = handlers.onLater.mock.calls[0]!;
  expect(Date.parse(until)).toBeGreaterThan(Date.now());
});
test("a move that came back from Later says when it was set aside", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  render(
    <InboxTurnRow item={{ ...row("review"), later: { setAt: past, until: past } }} {...props()} />,
  );
  expect(screen.getByTestId("inbox-back-from-later").textContent).toMatch(/^Back from Later/u);
});
