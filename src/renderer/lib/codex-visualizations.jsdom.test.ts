import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vite-plus/test";
import { codexVisualizationQueryOptions } from "./codex-visualizations";
const boundary = vi.hoisted(() => ({
  read: vi.fn(async () => ({ contents: "<p>Chart</p>", path: "/chart.html" })),
}));
vi.mock("./renderer-command", () => ({ invokeRendererQuery: boundary.read }));

test("ordinary HTML reuses inactive file data for 15 seconds while an explicit live role releases immediately", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  try {
    boundary.read.mockClear();
    const input = { hostId: "local", sourceThreadId: "source", file: "chart.html" };
    const options = codexVisualizationQueryOptions(input, "revision", "inline");
    const first = new QueryObserver(client, options);
    const releaseFirst = first.subscribe(() => {});
    await first.refetch();
    releaseFirst();
    await vi.advanceTimersByTimeAsync(14_999);
    const next = new QueryObserver(client, options);
    const releaseNext = next.subscribe(() => {});
    expect(next.getCurrentResult().data?.contents).toBe("<p>Chart</p>");
    expect(boundary.read).toHaveBeenCalledOnce();
    releaseNext();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    const liveOptions = codexVisualizationQueryOptions(input, "live", "live");
    const live = new QueryObserver(client, liveOptions);
    const releaseLive = live.subscribe(() => {});
    await live.refetch();
    releaseLive();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getQueryData(liveOptions.queryKey)).toBeUndefined();
  } finally {
    client.clear();
    vi.useRealTimers();
  }
});
