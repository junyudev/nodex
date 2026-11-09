import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { automationDecisionsQueryOptions } from "@/lib/query-options";
import { AutomationRecentDecisions } from "./automation-recent-decisions";

test("shows both positive and negative judgements with their factual reasons", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(automationDecisionsQueryOptions("automation").queryKey, [
    {
      id: "one",
      dispatchId: "one",
      automationId: "automation",
      mode: "dry_run",
      status: "completed",
      matched: true,
      reason: "The check failed in this repository",
      occurredAt: 0,
      pageId: null,
      sessionId: null,
    },
    {
      id: "two",
      dispatchId: "two",
      automationId: "automation",
      mode: "dry_run",
      status: "completed",
      matched: false,
      reason: "The discussion concerns a different project",
      occurredAt: 1000,
      pageId: null,
      sessionId: null,
    },
  ]);
  render(
    <QueryClientProvider client={client}>
      <AutomationRecentDecisions automationId="automation" timezone="UTC" />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Matched", { exact: true })).not.toBeNull();
  expect(screen.getByText("Not matched", { exact: true })).not.toBeNull();
  expect(screen.getByText("The check failed in this repository")).not.toBeNull();
  expect(screen.getByText("The discussion concerns a different project")).not.toBeNull();
});
