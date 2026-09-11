import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { ComposerFileSearchEvent } from "../../../../../shared/composer-file-search";
import { createComposerFileSearchSession } from "../../composer-file-search-operations";
import { useComposerWorkspaceFileSearch } from "./use-composer-workspace-file-search";

vi.mock("../../composer-file-search-operations", () => ({
  createComposerFileSearchSession: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const updated = (query: string): ComposerFileSearchEvent => ({
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
  const callbacks: Array<(event: ComposerFileSearchEvent) => void> = [];
  const update = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  vi.mocked(createComposerFileSearchSession).mockImplementation(({ onEvent }) => {
    callbacks.push(onEvent);
    return { update, stop };
  });
  const { result, rerender, unmount } = renderHook(useComposerWorkspaceFileSearch, {
    initialProps: { enabled: true, query: "a", workspaceRoot: "/first" },
  });
  rerender({ enabled: true, query: "abc", workspaceRoot: "/first" });
  expect(createComposerFileSearchSession).toHaveBeenCalledTimes(1);
  expect(update.mock.calls).toEqual([["a"], ["abc"]]);
  await act(async () => {
    callbacks[0]!(updated("a"));
  });
  expect(result.current).toEqual({ matches: [], loading: true });
  await act(async () => {
    callbacks[0]!(updated("abc"));
  });
  expect(result.current.matches.map((match) => match.fsPath)).toEqual(["/first/src/abc.ts"]);
  expect(result.current.loading).toBe(true);
  await act(async () => {
    callbacks[0]!({ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: "session" } });
  });
  expect(result.current.loading).toBe(false);
  rerender({ enabled: true, query: "abc", workspaceRoot: "/second" });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(createComposerFileSearchSession).toHaveBeenLastCalledWith({
    roots: ["/second"],
    onEvent: expect.any(Function),
  });
  await act(async () => {
    callbacks[0]!(updated("abc"));
  });
  expect(result.current).toEqual({ matches: [], loading: true });
  rerender({ enabled: false, query: "abc", workspaceRoot: "/second" });
  expect(result.current).toEqual({ matches: [], loading: false });
  expect(stop).toHaveBeenCalledTimes(2);
  unmount();
});
