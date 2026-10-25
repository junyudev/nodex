import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { CommandPaletteThreadSearchResult } from "./types";
import {
  clearCommandPaletteThreadSearchCacheForTests,
  useCommandPaletteThreadSearch,
} from "./command-palette-chat-search";

const apiMock = vi.hoisted(() => ({
  search: vi.fn<() => Promise<readonly CommandPaletteThreadSearchResult[]>>(),
}));

vi.mock("./renderer-command", () => ({ invokeRendererQuery: apiMock.search }));

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function contentResults(count: number, prefix = "needle"): CommandPaletteThreadSearchResult[] {
  return Array.from({ length: count }, (_, index) => ({
    thread: {
      threadId: `${prefix}-${index}`,
      sessionId: null,
      projectId: null,
      projectName: null,
      title: `Chat ${index}`,
      preview: "",
      cwd: null,
      gitBranch: null,
      projectless: true,
      pinned: false,
      pinnedOrder: null,
      statusType: "notLoaded",
      statusActiveFlags: [],
      createdAt: 1,
      updatedAt: 1,
    },
    snippet: `Content match for ${prefix}`,
  }));
}

afterEach(() => {
  vi.useRealTimers();
  apiMock.search.mockReset();
  clearCommandPaletteThreadSearchCacheForTests();
});

describe("command palette chat search requests", () => {
  test("retains same-query content matches while expansion loads or fails", async () => {
    vi.useFakeTimers();
    const initial = deferred<CommandPaletteThreadSearchResult[]>();
    const expansion = deferred<CommandPaletteThreadSearchResult[]>();
    const nextExpansion = deferred<CommandPaletteThreadSearchResult[]>();
    apiMock.search
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(expansion.promise)
      .mockReturnValueOnce(nextExpansion.promise);
    const { result, rerender } = renderHook(
      ({ query, limit }) => useCommandPaletteThreadSearch({ enabled: true, query, limit }),
      { initialProps: { query: "needle", limit: 6 } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(200));
    const initialRows = contentResults(6);
    await act(async () => initial.resolve(initialRows));
    expect(result.current.results).toEqual(initialRows);

    rerender({ query: " NEEDLE ", limit: 11 });
    expect(result.current).toMatchObject({ query: "needle", loading: true, results: initialRows });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(apiMock.search).toHaveBeenLastCalledWith("codex:threads:palette:search", {
      query: "NEEDLE",
      limit: 11,
    });
    await act(async () => expansion.reject(new Error("offline")));
    expect(result.current).toMatchObject({
      loading: false,
      error: "offline",
      results: initialRows,
    });

    rerender({ query: "needle", limit: 16 });
    expect(result.current.results).toEqual(initialRows);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    const expandedRows = contentResults(16);
    await act(async () => nextExpansion.resolve(expandedRows));
    expect(result.current).toMatchObject({ loading: false, error: null, results: expandedRows });
  });

  test("clears retained matches on a new query or close and rejects obsolete expansion", async () => {
    vi.useFakeTimers();
    const initial = deferred<CommandPaletteThreadSearchResult[]>();
    const obsolete = deferred<CommandPaletteThreadSearchResult[]>();
    const current = deferred<CommandPaletteThreadSearchResult[]>();
    apiMock.search
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(obsolete.promise)
      .mockReturnValueOnce(current.promise);
    const { result, rerender } = renderHook(useCommandPaletteThreadSearch, {
      initialProps: { enabled: true, query: "needle", limit: 6 },
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await act(async () => initial.resolve(contentResults(6)));
    rerender({ enabled: true, query: "needle", limit: 11 });
    await act(async () => vi.advanceTimersByTimeAsync(200));

    rerender({ enabled: true, query: "current", limit: 11 });
    expect(result.current).toMatchObject({ query: "current", results: [], loading: true });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await act(async () => obsolete.resolve(contentResults(11)));
    expect(result.current).toMatchObject({ query: "current", results: [], loading: true });
    const currentRows = contentResults(11, "current");
    await act(async () => current.resolve(currentRows));
    expect(result.current.results).toEqual(currentRows);

    rerender({ enabled: false, query: "current", limit: 11 });
    expect(result.current).toEqual({ query: "", results: [], loading: false, error: null });
  });
});
