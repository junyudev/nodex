import { act, fireEvent, screen } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { InboxMessage } from "./inbox-message";
import type { InboxItem } from "../../../shared/inbox";
const open = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/file-system-operations", () => ({ openExternalUrl: open }));
vi.mock("./inbox-message-document", () => ({
  InboxMessageDocument: () => <span>Review request</span>,
}));
const item: InboxItem = {
  pageId: "page",
  rowKind: "intake",
  turn: null,
  outcome: null,
  basis: { pageId: "page", contentHash: "hash" },
  pageKey: null,
  pageStatus: null,
  title: "Review request",
  body: "Please review",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-11-06T00:00:00Z",
  source: {
    kind: "github",
    externalThreadId: "github:github.com:10:42",
    actorLogin: "alice",
    repository: "owner/repo",
    number: 42,
    title: "Review request",
    url: "https://github.com/owner/repo/pull/42",
  },
  replyToPageId: null,
  kind: null,
  important: false,
  state: "open",
  suggestionState: "waiting",
  suggestionError: null,
  automationDecision: null,
  scope: { kind: "library" },
  location: { kind: "inbox" },
  proposal: null,
  revision: 1,
};
test("shows external repository and author provenance and opens its GitHub thread", async () => {
  const toggle = vi.fn();
  render(
    <InboxMessage
      item={item}
      selected={false}
      selectionActive={false}
      onToggleSelected={toggle}
      linkedChats={null}
      onOpenChat={() => {}}
      onOpenPage={() => {}}
      onUnmarkImportant={() => {}}
      editor={null}
      messageActions={null}
      strip={null}
      actions={null}
    />,
  );
  const link = screen.getByRole("link", { name: "owner/repo #42 · @alice" });
  expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/pull/42");
  await act(async () => {
    fireEvent.click(link);
    await Promise.resolve();
  });
  expect(open).toHaveBeenCalledWith("https://github.com/owner/repo/pull/42");
  expect(toggle).not.toHaveBeenCalled();
});
