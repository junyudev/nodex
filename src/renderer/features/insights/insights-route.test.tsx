import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { installWindowApi } from "@/test/browser-globals";

import type { InsightsUsageSnapshot } from "../../../shared/insights";
import { InsightsRoute } from "./insights-route";
import { localToday } from "./insights-model";
import { insightsTimeZone } from "./use-insights";

afterEach(cleanup);

const today = () => localToday(insightsTimeZone(), Date.now());

const snapshot = (overrides: Partial<InsightsUsageSnapshot> = {}): InsightsUsageSnapshot => ({
  access: "granted",
  revision: 1,
  scan: { state: "idle", filesDone: 0, filesTotal: 0, failedFiles: 0, finishedAtMs: 1 },
  pricing: "fresh",
  models: [
    {
      day: today(),
      provider: "claude",
      model: "claude-opus-5-5",
      uncachedInputTokens: 1e9,
      cachedInputTokens: 53e9,
      cacheCreationTokens: 0,
      outputTokens: 7e8,
      requests: 4000,
      costUsd: 14902,
      cacheSavingsUsd: 178250,
      priced: true,
    },
  ],
  messages: [[today(), 3416]],
  conversations: [[today(), 60]],
  hours: [[today(), 18, 54.7e9]],
  agents: [{ day: today(), turns: 40, activeSeconds: 7200, peakAgents: 19 }],
  ...overrides,
});

function mount(initial: InsightsUsageSnapshot) {
  let usage = initial;
  const invoke = vi.fn(async (channel: string, input?: { readonly granted?: boolean }) => {
    if (channel === "insights:usage") return usage;
    if (channel === "insights:content") return null;
    if (channel === "insights:access") {
      usage = input?.granted
        ? snapshot()
        : snapshot({ access: "unset", models: [], messages: [], hours: [], agents: [] });
      return { access: usage.access };
    }
    throw new Error(`Unexpected channel ${channel}`);
  });
  installWindowApi({ invoke, on: () => () => {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <InsightsRoute />
    </QueryClientProvider>,
  );
  return invoke;
}

const unset = () =>
  snapshot({ access: "unset", models: [], messages: [], conversations: [], hours: [], agents: [] });

test("asks before reading any history, then shows what it found", async () => {
  const invoke = mount(unset());
  const allow = await screen.findByRole("button", { name: "Read my agent history" });
  expect(screen.queryByRole("button", { name: "Share" })).toBeNull();

  fireEvent.click(allow);

  expect(await screen.findAllByText("54.7B")).toHaveLength(2);
  expect(invoke).toHaveBeenCalledWith("insights:access", { granted: true });
  expect(screen.getByText("Claude Opus 5.5")).toBeTruthy();
  expect(screen.getByText(/at API list price/)).toBeTruthy();
  expect(screen.getByText("19")).toBeTruthy();
});

test("says how far along it is while reading history", async () => {
  mount(
    snapshot({
      scan: {
        state: "scanning",
        filesDone: 1204,
        filesTotal: 6055,
        failedFiles: 0,
        finishedAtMs: null,
      },
    }),
  );
  expect(await screen.findByText(/1,204 of 6,055 files/)).toBeTruthy();
  expect(screen.getAllByText("54.7B").length).toBeGreaterThan(0);
});

test("keeps Library numbers honest when Core cannot answer", async () => {
  mount(snapshot());
  await screen.findAllByText("54.7B");
  expect(screen.getByText("Tasks finished").nextElementSibling?.textContent).toBe("—");
});

test("confirms before forgetting what it counted", async () => {
  const invoke = mount(snapshot());
  fireEvent.click(await screen.findByRole("button", { name: "Stop reading history" }));
  fireEvent.click(await screen.findByRole("button", { name: "Keep reading" }));
  expect(invoke).not.toHaveBeenCalledWith("insights:access", { granted: false });

  fireEvent.click(screen.getByRole("button", { name: "Stop reading history" }));
  fireEvent.click(await screen.findByRole("button", { name: "Stop and forget" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("insights:access", { granted: false }));
  expect(await screen.findByRole("button", { name: "Read my agent history" })).toBeTruthy();
});

test("explains an empty period instead of showing a page of zeros", async () => {
  mount(snapshot({ models: [], messages: [], hours: [], agents: [] }));
  expect(await screen.findByText("No agent activity in this period")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Share" }).hasAttribute("disabled")).toBe(true);
});
