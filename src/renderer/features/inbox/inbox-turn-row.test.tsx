import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { render, openNodexMenu } from "@/test/dom";
import type { InboxItem } from "../../../shared/inbox";
import type { TurnReason } from "../../../shared/page-turn";
import { InboxTurnRow } from "./inbox-turn-row";
afterEach(cleanup);
const row = (reason: TurnReason, options: string[] = []): InboxItem => ({
  rowKind: "turn",
  pageId: "page",
  pageKey: "NODEX-1",
  pageStatus: null,
  title: "Ship the change",
  body: "The exact question or report",
  bodyTruncated: false,
  bodyEditable: false,
  submittedAt: "2026-11-05T00:00:00Z",
  source: { kind: "user" },
  replyToPageId: null,
  kind: null,
  important: false,
  state: "open",
  suggestionState: "none",
  suggestionError: null,
  scope: { kind: "project", projectId: "project" },
  location: { kind: "other" },
  proposal: null,
  automationDecision: null,
  revision: 1,
  basis: { pageId: "page", contentHash: "0".repeat(64) },
  outcome: null,
  turn: {
    turn: {
      page_id: "page",
      actor: { kind: "member", member_id: "member" },
      reason,
      since: "2026-11-05T00:00:00Z",
      episode: "episode",
    },
    note_id: null,
    options,
    active_chat: {
      session_id: "chat",
      display_title: "Work chat",
      project_id: "project",
      project_name: "Project",
      thread_id: "thread",
      status: null,
      unread: false,
      archived: false,
    },
    pull_request_url: "https://example.com/pr/1",
    delivery_error: null,
  },
});
const props = () => ({
  onOpenPage: vi.fn(),
  onOpenChat: vi.fn(),
  onReply: vi.fn(),
  onAnswer: vi.fn().mockResolvedValue(undefined),
  onAccept: vi.fn().mockResolvedValue(undefined),
  onStart: vi.fn().mockResolvedValue(undefined),
  onOpenPR: vi.fn(),
});
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
  expect(screen.getByRole("button", { name: "NODEX-1 Ship the change" })).toBeTruthy();
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
