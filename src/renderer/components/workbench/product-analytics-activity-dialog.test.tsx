import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { ProductAnalyticsActivity } from "../../../shared/product-analytics/activity";
import { ProductAnalyticsActivityDialog } from "./product-analytics-activity-dialog";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/product-analytics", () => ({ readProductAnalyticsActivity: read }));

const renderDialog = (activity: ProductAnalyticsActivity, onClose = vi.fn()) => {
  read.mockResolvedValue(activity);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductAnalyticsActivityDialog onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
};

afterEach(cleanup);

test("shows the identity, shared fields, and each event with its state", async () => {
  renderDialog({
    active: true,
    installationId: "6f1f8f2e-1f0a-4c55-9d0e-2b7f0c8a1e11",
    context: { app_version: "1.2.3", os: "darwin" },
    pending: [{ time: 2_000, event: { name: "app_active", properties: {} } }],
    sent: [
      {
        time: 1_000,
        event: {
          name: "thread_opened",
          value: 120,
          properties: { outcome: "success", thread_kind: "local" },
        },
      },
    ],
  });
  await screen.findByText("6f1f8f2e-1f0a-4c55-9d0e-2b7f0c8a1e11");
  screen.getByText("1.2.3");
  screen.getByText("app_active");
  screen.getByText("value=120 outcome=success thread_kind=local");
  screen.getByText(/^Waiting/);
  screen.getByText(/^Sent/);
});

test("says plainly when nothing is being sent, and closes", async () => {
  const onClose = renderDialog({
    active: false,
    installationId: null,
    context: {},
    pending: [],
    sent: [],
  });
  await screen.findByText("Nothing is being sent from this installation.");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
