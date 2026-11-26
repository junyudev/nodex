import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { openNodexMenu } from "@/test/dom";
import { InboxTurnRow } from "./inbox-turn-row";
import { turnRow as row, turnRowHandlers as props } from "./inbox-turn-row.test-support";
vi.mock("@/lib/space-host-runtime", () => ({ useSpaceHostAvailable: () => true }));
afterEach(cleanup);
test.each([
  ["approval", "Open chat"],
  ["review", "Accept"],
  ["reply", "Open chat"],
  ["blocked", "Open chat"],
  ["failed", "Open chat"],
  ["stalled", "Open chat"],
  ["ready_to_start", "Start"],
] as const)("offers the typed action for %s", async (reason, action) => {
  const handlers = props();
  renderWithAppMaitai(<InboxTurnRow item={row(reason)} {...handlers} />);
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
  renderWithAppMaitai(
    <InboxTurnRow
      item={row("question", ["First", "Second", "Third", "Fourth", "Fifth"])}
      {...handlers}
    />,
  );
  expect(screen.getByText("The exact question or report")).toBeTruthy();
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
test.each(["review", "failed", "reply"] as const)(
  "explains undeliverable %s replies beside the fact",
  (reason) => {
    const item = row(reason);
    renderWithAppMaitai(
      <InboxTurnRow item={{ ...item, turn: { ...item.turn!, active_chat: null } }} {...props()} />,
    );
    expect(screen.getByText("The exact question or report")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open chat" })).toBeTruthy();
  },
);
test("a question that offers options still opens its chat", async () => {
  const handlers = props();
  renderWithAppMaitai(<InboxTurnRow item={row("question", ["Yes", "No"])} {...handlers} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await Promise.resolve();
  });
  expect(handlers.onOpenChat).toHaveBeenCalledOnce();
});
test("a review offers a labeled Open chat button between Reply and Accept", async () => {
  const handlers = props();
  renderWithAppMaitai(<InboxTurnRow item={row("review")} {...handlers} />);
  const card = within(screen.getByRole("article"));
  const openChat = card.getByRole("button", { name: "Open chat" });
  expect(within(openChat).getByText("Open chat")).toBeTruthy();
  expect(card.getAllByRole("button").slice(-3)).toEqual([
    card.getByRole("button", { name: "Reply" }),
    openChat,
    card.getByRole("button", { name: "Accept" }),
  ]);
  await act(async () => {
    fireEvent.click(openChat);
    await Promise.resolve();
  });
  expect(handlers.onOpenChat).toHaveBeenCalledOnce();
});
test("work that has not started has no chat to open", () => {
  renderWithAppMaitai(<InboxTurnRow item={row("ready_to_start")} {...props()} />);
  expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
});
test.each([
  ["question", "Needs your answer"],
  ["approval", "Needs your approval"],
  ["review", "Ready for your review"],
  ["reply", "Needs your reply"],
  ["failed", "Failed · needs you"],
  ["ready_to_start", "Ready to start"],
] as const)("words a %s turn as the reader's own", (reason, phrase) => {
  renderWithAppMaitai(<InboxTurnRow item={row(reason)} {...props()} />);
  expect(screen.getByText(phrase)).toBeTruthy();
});
test("a reply turn quotes the chat and answers it from the Inbox", async () => {
  const handlers = props();
  renderWithAppMaitai(<InboxTurnRow item={row("reply")} {...handlers} />);
  expect(screen.getByText("The exact question or report")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await Promise.resolve();
  });
  expect(handlers.onReply).toHaveBeenCalledOnce();
});
test("a move that can wait is set aside until a chosen time", async () => {
  const handlers = props();
  renderWithAppMaitai(<InboxTurnRow item={row("review")} {...handlers} />);
  await openNodexMenu(screen.getByRole("button", { name: "Snooze" }));
  const option = await screen.findByRole("menuitem", { name: /^In 1 hour/ });
  await act(async () => {
    fireEvent.click(option);
    await Promise.resolve();
  });
  const [until] = handlers.onSnooze.mock.calls[0]!;
  expect(Date.parse(until)).toBeGreaterThan(Date.now());
});
test("a move that came back from Snooze says when it was set aside", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  renderWithAppMaitai(
    <InboxTurnRow item={{ ...row("review"), snooze: { setAt: past, until: past } }} {...props()} />,
  );
  expect(screen.getByTestId("inbox-back-from-snooze").textContent).toMatch(/^Back from snooze/u);
});
