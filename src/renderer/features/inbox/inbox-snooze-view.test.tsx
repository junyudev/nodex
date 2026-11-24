import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { openNodexMenu, render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import type { InboxItem } from "../../../shared/inbox";
import { formatInboxSnoozeTime } from "./inbox-snooze";
import { InboxSnoozeView, type InboxSnoozeHandlers } from "./inbox-snooze-view";

const setAside = (pageId: string, title: string, until: string): InboxItem =>
  ({
    rowKind: "intake",
    pageId,
    pageKey: `IN-${pageId}`,
    title,
    body: title,
    bodyTruncated: false,
    source: { kind: "user" },
    important: false,
    waiting: true,
    scope: { kind: "library" },
    location: { kind: "inbox" },
    snooze: { setAt: "2026-11-03T10:00:00.000Z", until },
  }) as InboxItem;

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

const handlers = (): InboxSnoozeHandlers => ({
  onOpenPage: vi.fn(),
  onReturn: vi.fn(),
  onReschedule: vi.fn(),
  onHold: vi.fn(),
  onSetDone: vi.fn(),
  onDelete: vi.fn(),
});

const renderSnooze = (items: readonly InboxItem[], commands = handlers()) => {
  render(
    <TestQueryProvider>
      <InboxSnoozeView items={items} {...commands} />
    </TestQueryProvider>,
  );
  return commands;
};

describe("InboxSnoozeView", () => {
  test("says what Snoozed is for while nothing is set aside", () => {
    renderSnooze([]);
    expect(screen.getByText("Nothing set aside")).toBeTruthy();
  });

  test("lists timed messages under their day", () => {
    const soon = new Date(Date.now() + 86_400_000 * 30).toISOString();
    renderSnooze([
      setAside("2", "Read the paper", tomorrow()),
      setAside("1", "Renew the certificate", soon),
    ]);
    const nextDay = screen.getByRole("region", { name: "Tomorrow" });
    expect(within(nextDay).getByText("Read the paper")).toBeTruthy();
    expect(within(nextDay).queryByText("Renew the certificate")).toBeNull();
    expect(screen.getAllByRole("region")).toHaveLength(2);
  });

  test("a message returns to the Inbox now, or changes when it comes back", async () => {
    const commands = renderSnooze([setAside("1", "Read the paper", tomorrow())]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Return to Inbox" }));
      await Promise.resolve();
    });
    expect(commands.onReturn).toHaveBeenCalledWith("1");
    await openNodexMenu(screen.getByRole("button", { name: "Change time" }));
    const option = await screen.findByRole("menuitem", { name: /^In 3 hours/ });
    await act(async () => {
      fireEvent.click(option);
      await Promise.resolve();
    });
    const [pageId, snoozedUntil] = vi.mocked(commands.onReschedule).mock.calls[0]!;
    expect(pageId).toBe("1");
    expect(Date.parse(snoozedUntil!)).toBeGreaterThan(Date.now());
  });

  test("opening a line shows the message and the rest of its actions", async () => {
    const until = tomorrow();
    const commands = renderSnooze([setAside("1", "Read the paper", until)]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Read the paper/ }));
      await Promise.resolve();
    });
    expect(screen.getByText(`Returns ${formatInboxSnoozeTime(until, new Date())}`)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
      await Promise.resolve();
    });
    expect(commands.onSetDone).toHaveBeenCalledWith("1");
  });
});
