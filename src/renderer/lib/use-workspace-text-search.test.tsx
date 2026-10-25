import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type {
  WorkspaceTextSearchEvent,
  WorkspaceTextSearchMatch,
} from "../../shared/workspace-text-search";
import { createWorkspaceTextSearch } from "./workspace-text-search-operations";
import { useWorkspaceTextSearch } from "./use-workspace-text-search";

vi.mock("./workspace-text-search-operations", () => ({ createWorkspaceTextSearch: vi.fn() }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
const match: WorkspaceTextSearchMatch = {
  path: "/repo/a.ts",
  root: "/repo",
  relativePath: "a.ts",
  line: 2,
  column: 3,
  preview: "a word",
  matchRanges: [{ start: 2, end: 6 }],
};
const props = {
  enabled: true,
  scope: { hostId: "local", roots: ["/repo"] },
  query: "word",
  fileMask: "",
};
const advance = async () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });

test("debounces edits, retains disabled stale matches until a fresh event, and fences retired scopes", async () => {
  const callbacks: Array<(event: WorkspaceTextSearchEvent) => void> = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  vi.mocked(createWorkspaceTextSearch).mockImplementation(({ onEvent }) => {
    callbacks.push(onEvent);
    const stop = vi.fn().mockResolvedValue(undefined);
    stops.push(stop);
    return { stop };
  });
  const { result, rerender, unmount } = renderHook(useWorkspaceTextSearch, { initialProps: props });
  rerender({ ...props, query: "word2" });
  expect(createWorkspaceTextSearch).not.toHaveBeenCalled();
  await advance();
  expect(createWorkspaceTextSearch).toHaveBeenCalledTimes(1);
  expect(createWorkspaceTextSearch).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: "word2" }),
  );
  await act(async () => {
    callbacks[0]!({ requestId: "first", type: "match", match });
  });
  expect(result.current.matchesCurrent).toBe(true);
  rerender({ ...props, query: "word3" });
  expect(result.current).toMatchObject({
    matches: [match],
    matchesCurrent: false,
    refreshing: true,
  });
  expect(stops[0]).toHaveBeenCalledOnce();
  await advance();
  await act(async () => {
    callbacks[0]!({ requestId: "first", type: "done", limited: false });
  });
  expect(result.current.matchesCurrent).toBe(false);
  await act(async () => {
    callbacks[1]!({ requestId: "second", type: "done", limited: false });
  });
  expect(result.current).toMatchObject({ matches: [], matchesCurrent: true, loading: false });
  rerender({ ...props, scope: { hostId: "remote", roots: ["/repo"] } });
  expect(result.current).toMatchObject({ matches: [], matchesCurrent: false, loading: true });
  await advance();
  await act(async () => {
    callbacks[2]!({ requestId: "third", type: "match", match });
  });
  rerender({ ...props, enabled: false });
  expect(result.current).toMatchObject({ matches: [], matchesCurrent: false, loading: false });
  expect(stops[2]).toHaveBeenCalledOnce();
  unmount();
});

test("rejects invalid multiline queries and masks before creating a backend request", async () => {
  const { result, rerender } = renderHook(useWorkspaceTextSearch, {
    initialProps: { ...props, query: "a\nb" },
  });
  await advance();
  expect(result.current.error).toBe("invalid-query");
  rerender({ ...props, query: "word", fileMask: "*.{ts" });
  await advance();
  expect(result.current.error).toBe("invalid-file-mask");
  expect(createWorkspaceTextSearch).not.toHaveBeenCalled();
});

test("a restarted identical query cannot reactivate the previous request's matches", async () => {
  const callbacks: Array<(event: WorkspaceTextSearchEvent) => void> = [];
  vi.mocked(createWorkspaceTextSearch).mockImplementation(({ onEvent }) => {
    callbacks.push(onEvent);
    return { stop: vi.fn().mockResolvedValue(undefined) };
  });
  const { result, rerender } = renderHook(useWorkspaceTextSearch, { initialProps: props });
  await advance();
  await act(async () => {
    callbacks[0]!({ requestId: "first", type: "match", match });
  });
  rerender({ ...props, query: "another" });
  rerender(props);
  expect(result.current).toMatchObject({ matches: [match], matchesCurrent: false, loading: true });
  await advance();
  await act(async () => {
    callbacks[1]!({ requestId: "next", type: "done", limited: false });
  });
  expect(result.current.matchesCurrent).toBe(true);
  rerender({ ...props, enabled: false });
  rerender(props);
  expect(result.current).toMatchObject({ matchesCurrent: false, loading: true });
});
