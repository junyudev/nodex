import { describe, expect, test } from "vite-plus/test";
import { act, waitFor } from "@testing-library/react";
import { createElement, useLayoutEffect, useMemo } from "react";
import { render, settleAsyncRender } from "../../test/dom";
import {
  ContentSearchProvider,
  useContentSearch,
  useRegisterContentSearchSource,
  type ContentSearchController,
  type ContentSearchLocalSource,
} from "./content-search-context";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("ContentSearchProvider", () => {
  test("aborts the previous local ensureVisible before activating the next match", async () => {
    const ensureSignals: AbortSignal[] = [];
    const activatedIds: string[] = [];
    let controller: ContentSearchController | null = null;

    function Probe() {
      const currentController = useContentSearch();
      useLayoutEffect(() => {
        controller = currentController;
      }, [currentController]);
      const source = useMemo<ContentSearchLocalSource>(
        () => ({
          domain: "conversation",
          contextId: "conversation:thread",
          search: (query) => ({
            query,
            totalMatches: 2,
            capped: false,
            matches: [
              {
                id: "match-1",
                domain: "conversation",
                contextId: "conversation:thread",
                ordinal: 0,
                label: "needle one",
                meta: {},
              },
              {
                id: "match-2",
                domain: "conversation",
                contextId: "conversation:thread",
                ordinal: 1,
                label: "needle two",
                meta: {},
              },
            ],
          }),
          ensureVisible: (_match, { signal }) => {
            ensureSignals.push(signal);
            if (ensureSignals.length > 1) return;
            return new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
          activate: (match) => {
            activatedIds.push(match.id);
          },
          clear: () => {},
        }),
        [],
      );
      useRegisterContentSearchSource(source);
      return createElement("div");
    }

    render(createElement(ContentSearchProvider, null, createElement(Probe)));
    await settleAsyncRender();

    if (!controller) throw new Error("Expected content search controller");
    await act(async () => {
      controller?.requestOpen({ preferredDomain: "conversation" });
      controller?.setQuery("needle");
    });
    await waitFor(() => {
      expect(ensureSignals.length).toBe(1);
    });

    expect(activatedIds.length).toBe(0);

    await act(async () => {
      controller?.goNext();
    });
    await waitFor(() => {
      expect(ensureSignals[0]?.aborted ?? false).toBe(true);
      expect(ensureSignals.length).toBe(2);
      expect(activatedIds[0] ?? "").toBe("match-2");
    });
  });

  test("does not activate stale local results after the query changes", async () => {
    const oldSearch = createDeferred<Awaited<ReturnType<ContentSearchLocalSource["search"]>>>();
    const activatedQueries: string[] = [];
    const searchedQueries: string[] = [];
    let controller: ContentSearchController | null = null;

    function Probe() {
      const currentController = useContentSearch();
      useLayoutEffect(() => {
        controller = currentController;
      }, [currentController]);
      const source = useMemo<ContentSearchLocalSource>(
        () => ({
          domain: "conversation",
          contextId: "conversation:thread",
          search: (query) => {
            searchedQueries.push(query);
            if (query === "old") return oldSearch.promise;
            return {
              query,
              totalMatches: 0,
              capped: false,
              matches: [],
            };
          },
          activate: (_match, query) => {
            activatedQueries.push(query);
          },
          clear: () => {},
        }),
        [],
      );
      useRegisterContentSearchSource(source);
      return createElement("div");
    }

    render(createElement(ContentSearchProvider, null, createElement(Probe)));
    await settleAsyncRender();

    if (!controller) throw new Error("Expected content search controller");
    await act(async () => {
      controller?.requestOpen({ preferredDomain: "conversation" });
      controller?.setQuery("old");
    });
    await waitFor(() => {
      expect(searchedQueries[0] ?? "").toBe("old");
    });
    await act(async () => {
      controller?.setQuery("new");
      oldSearch.resolve({
        query: "old",
        totalMatches: 1,
        capped: false,
        matches: [
          {
            id: "old-match",
            domain: "conversation",
            contextId: "conversation:thread",
            ordinal: 0,
            label: "old",
            meta: {},
          },
        ],
      });
    });
    await waitFor(() => {
      expect(searchedQueries[1] ?? "").toBe("new");
      expect(controller?.state.loadingDomain ?? null).toBe(null);
      expect(controller?.state.resultByDomain.conversation?.query ?? "").toBe("new");
    });

    expect(activatedQueries.length).toBe(0);
  });

  test("aborts an in-flight local search when the query changes", async () => {
    const searchSignals: AbortSignal[] = [];
    const searchedQueries: string[] = [];
    let controller: ContentSearchController | null = null;

    function Probe() {
      const currentController = useContentSearch();
      useLayoutEffect(() => {
        controller = currentController;
      }, [currentController]);
      const source = useMemo<ContentSearchLocalSource>(
        () => ({
          domain: "diff",
          contextId: "diff:thread",
          search: (query, _limit, options) => {
            searchedQueries.push(query);
            if (options) searchSignals.push(options.signal);
            return new Promise((resolve) => {
              options?.signal.addEventListener(
                "abort",
                () => {
                  resolve({ query, matches: [], totalMatches: 0, capped: false });
                },
                { once: true },
              );
            });
          },
          activate: () => {},
          clear: () => {},
        }),
        [],
      );
      useRegisterContentSearchSource(source);
      return createElement("div");
    }

    render(createElement(ContentSearchProvider, null, createElement(Probe)));
    await settleAsyncRender();

    if (!controller) throw new Error("Expected content search controller");
    await act(async () => {
      controller?.requestOpen({ preferredDomain: "diff" });
      controller?.setQuery("old");
    });
    await waitFor(() => {
      expect(searchedQueries).toEqual(["old"]);
    });

    await act(async () => {
      controller?.setQuery("new");
    });
    await waitFor(() => {
      expect(searchSignals[0]?.aborted).toBe(true);
      expect(searchedQueries).toEqual(["old", "new"]);
    });
  });

  test("cycles within stored matches when the exact total is capped", async () => {
    const activatedIds: string[] = [];
    let controller: ContentSearchController | null = null;

    function Probe() {
      const currentController = useContentSearch();
      useLayoutEffect(() => {
        controller = currentController;
      }, [currentController]);
      const source = useMemo<ContentSearchLocalSource>(
        () => ({
          domain: "diff",
          contextId: "diff:thread",
          search: (query) => ({
            query,
            totalMatches: 300,
            capped: true,
            matches: [
              { id: "match-1", domain: "diff", contextId: "diff:thread", ordinal: 1 },
              { id: "match-2", domain: "diff", contextId: "diff:thread", ordinal: 2 },
            ],
          }),
          activate: (match) => {
            activatedIds.push(match.id);
          },
          clear: () => {},
        }),
        [],
      );
      useRegisterContentSearchSource(source);
      return createElement("div");
    }

    render(createElement(ContentSearchProvider, null, createElement(Probe)));
    await settleAsyncRender();

    if (!controller) throw new Error("Expected content search controller");
    await act(async () => {
      controller?.requestOpen({ preferredDomain: "diff" });
      controller?.setQuery("needle");
    });
    await waitFor(() => {
      expect(activatedIds.at(-1)).toBe("match-1");
    });

    await act(async () => {
      controller?.goPrevious();
    });
    await waitFor(() => {
      expect(activatedIds.at(-1)).toBe("match-2");
      expect(controller?.state.activeIndexByDomain.diff).toBe(1);
    });
  });
});
