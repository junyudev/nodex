import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { FileSearchEvent } from "../../shared/file-search";
import { createFileSearchSession } from "./file-search-operations";
import { useFileSearch } from "./use-file-search";

vi.mock("./file-search-operations", () => ({
  createFileSearchSession: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const updated = (query: string): FileSearchEvent => ({
  method: "fuzzyFileSearch/sessionUpdated",
  params: {
    sessionId: "session",
    query,
    files: [
      {
        root: "/first",
        path: "src/abc.ts",
        file_name: "abc.ts",
        match_type: "file",
        score: 10,
        indices: null,
      },
    ],
  },
});

test("reuses the native session across edits and fences old roots and late disposal events", async () => {
  const callbacks: Array<(event: FileSearchEvent) => void> = [];
  const update = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  vi.mocked(createFileSearchSession).mockImplementation(({ onEvent }) => {
    callbacks.push(onEvent);
    return { update, stop };
  });
  const { result, rerender, unmount } = renderHook(useFileSearch, {
    initialProps: { enabled: true, query: "a", scope: { hostId: "local", roots: ["/first"] } },
  });
  rerender({ enabled: true, query: "abc", scope: { hostId: "local", roots: ["/first"] } });
  expect(createFileSearchSession).toHaveBeenCalledTimes(1);
  expect(update.mock.calls).toEqual([["a"], ["abc"]]);
  await act(async () => {
    callbacks[0]!(updated("a"));
  });
  expect(result.current).toEqual({ matches: [], loading: true, error: null });
  await act(async () => {
    callbacks[0]!(updated("abc"));
  });
  expect(result.current.matches.map((match) => match.fsPath)).toEqual(["/first/src/abc.ts"]);
  expect(result.current.loading).toBe(true);
  await act(async () => {
    callbacks[0]!({ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: "session" } });
  });
  expect(result.current.loading).toBe(false);
  rerender({ enabled: true, query: "abc", scope: { hostId: "local", roots: ["/second"] } });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(createFileSearchSession).toHaveBeenLastCalledWith({
    hostId: "local",
    roots: ["/second"],
    onEvent: expect.any(Function),
  });
  await act(async () => {
    callbacks[0]!(updated("abc"));
  });
  expect(result.current).toEqual({ matches: [], loading: true, error: null });
  rerender({ enabled: true, query: "abc", scope: { hostId: "remote", roots: ["/second"] } });
  expect(stop).toHaveBeenCalledTimes(2);
  expect(createFileSearchSession).toHaveBeenLastCalledWith({
    hostId: "remote",
    roots: ["/second"],
    onEvent: expect.any(Function),
  });
  await act(async () => {
    callbacks[1]!(updated("abc"));
  });
  expect(result.current).toEqual({ matches: [], loading: true, error: null });
  rerender({ enabled: false, query: "abc", scope: { hostId: "remote", roots: ["/second"] } });
  expect(result.current).toEqual({ matches: [], loading: false, error: null });
  expect(stop).toHaveBeenCalledTimes(3);
  unmount();
});
