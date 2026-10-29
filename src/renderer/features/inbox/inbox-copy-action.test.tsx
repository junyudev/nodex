import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { toast } from "@/components/ui/toast";
import { writeTextToClipboard } from "@/lib/clipboard";
import { loadPageDocumentMaterialization } from "@/lib/page-prompt-context";
import { render } from "@/test/dom";
import type { InboxItem } from "../../../shared/inbox";
import { InboxCopyAction } from "./inbox-copy-action";

vi.mock("@/lib/clipboard", () => ({ writeTextToClipboard: vi.fn(async () => true) }));
vi.mock("@/lib/page-prompt-context", () => ({ loadPageDocumentMaterialization: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), danger: vi.fn() } }));

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  pageId: "page:1",
  outcome: null,
  basis: { pageId: "page:1", contentHash: "content:1" },
  pageKey: "NOD-1",
  pageStatus: null,
  title: "Homepage positioning",
  body: "Homepage feels like a dev tool",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-10-11T10:00:00.000Z",
  source: { kind: "user" },
  kind: null,
  important: false,
  state: "open",
  suggestionState: "settled",
  suggestionError: null,
  firing: null,
  scope: { kind: "project", projectId: "project:nodex" },
  location: { kind: "inbox" },
  proposal: null,
  revision: 1,
  ...overrides,
});

const pressCopy = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await Promise.resolve();
  });
};

afterEach(() => vi.clearAllMocks());

describe("InboxCopyAction", () => {
  test("copies the message as shown and confirms it", async () => {
    render(<InboxCopyAction item={item()} />);
    await pressCopy();
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeTextToClipboard).toHaveBeenCalledWith("Homepage feels like a dev tool");
    expect(loadPageDocumentMaterialization).not.toHaveBeenCalled();
  });

  test("copies the whole Page when the stream shows only part of the message", async () => {
    vi.mocked(loadPageDocumentMaterialization).mockResolvedValue({
      markdown: "The complete message",
    } as Awaited<ReturnType<typeof loadPageDocumentMaterialization>>);
    const moved = item({
      bodyTruncated: true,
      location: {
        kind: "database",
        databaseId: "db:site",
        databaseName: "Site",
        projectId: "project:site",
        projectName: "Site",
      },
    });
    render(<InboxCopyAction item={moved} />);
    await pressCopy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalledWith("The complete message"));
    // A filed message is read from the Project it was filed in, not from its Inbox.
    expect(loadPageDocumentMaterialization).toHaveBeenCalledWith({
      routingContext: { kind: "project", projectId: "project:site" },
      pageId: "page:1",
    });
  });

  test("says so when the message could not be copied", async () => {
    vi.mocked(loadPageDocumentMaterialization).mockRejectedValue(new Error("offline"));
    render(<InboxCopyAction item={item({ bodyTruncated: true })} />);
    await pressCopy();
    await waitFor(() => expect(toast.danger).toHaveBeenCalledWith("Couldn’t copy the message"));
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(writeTextToClipboard).not.toHaveBeenCalled();
  });
});
