import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LIBRARY_INBOX, projectInbox } from "../../shared/inbox";
import {
  consumeInboxEntryOpen,
  requestInboxEntryOpen,
  useInboxEntryOpen,
} from "./inbox-entry-navigation";

describe("Inbox notification navigation", () => {
  it("retains the exact entry until its scoped Inbox mounts", async () => {
    const request = {
      pageId: "page:result",
      scope: projectInbox("project"),
    };
    requestInboxEntryOpen(request);
    const other = renderHook(() => useInboxEntryOpen(LIBRARY_INBOX));
    expect(other.result.current).toBeNull();
    const inbox = renderHook(() => useInboxEntryOpen(projectInbox("project")));
    expect(inbox.result.current).toEqual(request);
    await act(async () => {
      consumeInboxEntryOpen(request);
      await Promise.resolve();
    });
    expect(inbox.result.current).toBeNull();
  });
  it("does not let an earlier navigation consume a newer notification", async () => {
    const first = { pageId: "page:first", scope: LIBRARY_INBOX, view: "inbox" as const };
    const next = { ...first, pageId: "page:next" };
    const inbox = renderHook(() => useInboxEntryOpen(LIBRARY_INBOX));
    await act(async () => {
      requestInboxEntryOpen(first);
      requestInboxEntryOpen(next);
      consumeInboxEntryOpen(first);
      await Promise.resolve();
    });
    expect(inbox.result.current?.pageId).toBe(next.pageId);
    await act(async () => {
      consumeInboxEntryOpen(next);
      await Promise.resolve();
    });
    expect(inbox.result.current).toBeNull();
  });
});
