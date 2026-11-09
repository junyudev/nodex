import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@/test/dom";
import type { InboxItem } from "../../../shared/inbox";
import { InboxProblemRow } from "./inbox-problem-row";
const retry = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/inbox-runtime", () => ({ retryInboxProblem: retry }));
afterEach(() => {
  cleanup();
  retry.mockClear();
});
const row = (fix: "reconnect" | "retry" | "open_card"): InboxItem => ({
  pageId: "problem",
  rowKind: "problem",
  problem: {
    id: "problem",
    library_id: "library",
    page_id: "card",
    kind: "channel_failing",
    scope: "outbox",
    summary: "GitHub reply needs attention",
    fix,
    first_failure_at_ms: 1,
    last_failure_at_ms: 3,
    consecutive_failures: 3,
    evidence: { reason: "Unavailable" },
  },
  turn: null,
  basis: { pageId: "problem", contentHash: "0".repeat(64) },
  pageKey: null,
  pageStatus: null,
  title: "GitHub reply needs attention",
  body: "",
  bodyEditable: false,
  bodyTruncated: false,
  submittedAt: "2026-11-06T00:00:00Z",
  source: { kind: "user" },
  replyToPageId: null,
  kind: null,
  important: false,
  state: "open",
  outcome: null,
  suggestionState: "none",
  suggestionError: null,
  scope: { kind: "all" },
  location: { kind: "other" },
  proposal: null,
  revision: 1,
});
test.each([
  ["reconnect", "Reconnect"],
  ["open_card", "Open card"],
  ["retry", "Retry"],
] as const)("offers one fix for %s", async (fix, label) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const sources = vi.fn();
  const page = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <InboxProblemRow item={row(fix)} onOpenGitHubSettings={sources} onOpenPage={page} />
    </QueryClientProvider>,
  );
  expect(screen.getAllByRole("button")).toHaveLength(1);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await Promise.resolve();
  });
  await waitFor(() => {
    if (fix === "retry")
      expect(retry).toHaveBeenCalledWith(expect.objectContaining({ problemId: "problem" }));
    else if (fix === "reconnect") expect(sources).toHaveBeenCalledOnce();
    else expect(page).toHaveBeenCalledWith("card");
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: label }).hasAttribute("disabled")).toBe(false),
  );
  client.clear();
});
