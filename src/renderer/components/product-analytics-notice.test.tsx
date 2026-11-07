import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ProductAnalyticsNotice } from "./product-analytics-notice";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  presented: vi.fn(),
  acknowledge: vi.fn(),
}));

vi.mock("@/lib/product-analytics", () => ({
  readProductAnalyticsNotice: mocks.read,
  markProductAnalyticsNoticePresented: mocks.presented,
  acknowledgeProductAnalyticsNotice: mocks.acknowledge,
}));

const renderNotice = (onManage = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProductAnalyticsNotice onManage={onManage} />
    </QueryClientProvider>,
  );
  return onManage;
};

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue({ present: true });
  mocks.presented.mockReset().mockResolvedValue(undefined);
  mocks.acknowledge.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

test("tells Main it was shown, so the grace period starts when a person can see it", async () => {
  renderNotice();
  await screen.findByRole("status");
  await waitFor(() => expect(mocks.presented).toHaveBeenCalledTimes(1));
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});

test("Got it dismisses and acknowledges", async () => {
  const onManage = renderNotice();
  fireEvent.click(await screen.findByRole("button", { name: "Got it" }));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
  expect(onManage).not.toHaveBeenCalled();
});

test("Manage dismisses and opens the setting", async () => {
  const onManage = renderNotice();
  fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(onManage).toHaveBeenCalledTimes(1);
  expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
});

test("stays away when nothing is shared or it was already seen, or Main cannot answer", async () => {
  mocks.read.mockResolvedValue({ present: false });
  renderNotice();
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  await Promise.resolve();
  expect(screen.queryByRole("status")).toBeNull();
  cleanup();

  mocks.read.mockRejectedValue(new Error("unavailable"));
  renderNotice();
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  expect(screen.queryByRole("status")).toBeNull();
  expect(mocks.presented).not.toHaveBeenCalled();
});
