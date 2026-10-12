import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  BrowserSidebarCommand,
  BrowserSidebarCommandResult,
  BrowserSidebarFindState,
  BrowserSidebarTabIdentity,
} from "../../../shared/browser-sidebar";
import {
  CONTENT_SEARCH_DEBOUNCE_MS,
  CONTENT_SEARCH_INPUT_ID,
  CONTENT_SEARCH_LOCAL_MATCH_LIMIT,
  buildContentSearchResultLabel,
  canNavigateContentSearchMatches,
  cycleContentSearchDomain,
  normalizeContentSearchQuery,
  readSingleLineSelectionText,
  resolveContentSearchDomain,
  type ContentSearchDomain,
  type ContentSearchLabelInput,
  type ContentSearchLocalDomain,
  type ContentSearchLocalMatch,
  type ContentSearchLocalResult,
  type ContentSearchOpenRequest,
} from "./content-search-model";

export type {
  ContentSearchDomain,
  ContentSearchLocalDomain,
  ContentSearchLocalMatch,
  ContentSearchLocalResult,
  ContentSearchOpenRequest,
  ContentSearchOpenSource,
} from "./content-search-model";

export interface ContentSearchLocalSource {
  domain: ContentSearchLocalDomain;
  contextId: string;
  search: (
    query: string,
    limit: number,
    options?: { signal: AbortSignal },
  ) => Promise<ContentSearchLocalResult> | ContentSearchLocalResult;
  ensureVisible?: (
    match: ContentSearchLocalMatch,
    options: { signal: AbortSignal },
  ) => Promise<void> | void;
  /** Publish retained identities before navigation; DOM maintenance never starts another search. */
  publishResult?: (result: ContentSearchLocalResult, activeMatchId: string) => void;
  activate: (
    match: ContentSearchLocalMatch,
    query: string,
    options?: { signal: AbortSignal },
  ) => Promise<void> | void;
  clear: () => void;
}

export interface ContentSearchBrowserTarget extends BrowserSidebarTabIdentity {
  available: boolean;
  findState: BrowserSidebarFindState;
  command: (command: BrowserSidebarCommand) => Promise<BrowserSidebarCommandResult>;
}

function browserTargetIdentity(target: ContentSearchBrowserTarget): BrowserSidebarTabIdentity {
  return {
    browserConversationId: target.browserConversationId,
    browserViewScopeId: target.browserViewScopeId,
    browserTabId: target.browserTabId,
  };
}

interface ContentSearchState {
  open: boolean;
  domain: ContentSearchDomain;
  queryByDomain: Record<ContentSearchDomain, string>;
  activeIndexByDomain: Record<ContentSearchLocalDomain, number>;
  resultByDomain: Record<ContentSearchLocalDomain, ContentSearchLocalResult | null>;
  loadingDomain: ContentSearchLocalDomain | null;
}

export interface ContentSearchController {
  state: ContentSearchState;
  hasBrowserTarget: boolean;
  browserFindState: BrowserSidebarFindState | null;
  resultLabel: string;
  navigationDisabled: boolean;
  requestOpen: (request?: Partial<Omit<ContentSearchOpenRequest, "tick">>) => void;
  close: () => void;
  setDomain: (domain: ContentSearchDomain) => void;
  setQuery: (query: string) => void;
  goNext: () => void;
  goPrevious: () => void;
  registerLocalSource: (source: ContentSearchLocalSource) => () => void;
  registerBrowserTarget: (target: ContentSearchBrowserTarget) => () => void;
}

const EMPTY_LOCAL_RESULTS: Record<ContentSearchLocalDomain, ContentSearchLocalResult | null> = {
  conversation: null,
  diff: null,
};

const EMPTY_ACTIVE_INDEX: Record<ContentSearchLocalDomain, number> = {
  conversation: 0,
  diff: 0,
};

const EMPTY_QUERY_BY_DOMAIN: Record<ContentSearchDomain, string> = {
  conversation: "",
  diff: "",
  browser: "",
};

const ContentSearchContext = createContext<ContentSearchController | null>(null);

function isLocalDomain(domain: ContentSearchDomain): domain is ContentSearchLocalDomain {
  return domain !== "browser";
}

function focusContentSearchInput(): void {
  requestAnimationFrame(() => {
    const input = document.getElementById(CONTENT_SEARCH_INPUT_ID) as HTMLInputElement | null;
    input?.focus();
    input?.select();
  });
}

export function ContentSearchProvider({
  children,
  openRequest = null,
}: {
  children: ReactNode;
  openRequest?: ContentSearchOpenRequest | null;
}) {
  const sourcesRef = useRef(new Map<ContentSearchLocalDomain, ContentSearchLocalSource>());
  const browserTargetRef = useRef<ContentSearchBrowserTarget | null>(null);
  const searchSequenceRef = useRef(0);
  const activeEnsureAbortRef = useRef<AbortController | null>(null);
  const lastOpenRequestTickRef = useRef(openRequest?.tick ?? 0);
  const lastDomainRef = useRef<ContentSearchDomain>("conversation");
  const [sourceVersion, setSourceVersion] = useState(0);
  const [browserTarget, setBrowserTarget] = useState<ContentSearchBrowserTarget | null>(null);
  const [state, setState] = useState<ContentSearchState>({
    open: false,
    domain: "conversation",
    queryByDomain: EMPTY_QUERY_BY_DOMAIN,
    activeIndexByDomain: EMPTY_ACTIVE_INDEX,
    resultByDomain: EMPTY_LOCAL_RESULTS,
    loadingDomain: null,
  });

  const hasBrowserTarget = Boolean(browserTarget?.available);

  const clearDomain = useCallback((domain: ContentSearchDomain) => {
    if (!isLocalDomain(domain)) return;
    sourcesRef.current.get(domain)?.clear();
  }, []);

  const requestOpen = useCallback((request?: Partial<Omit<ContentSearchOpenRequest, "tick">>) => {
    setState((current) => {
      const focusedInput = document.activeElement?.id === CONTENT_SEARCH_INPUT_ID;
      const browserAvailable = Boolean(browserTargetRef.current?.available);
      const preferredDomain =
        request?.preferredDomain ?? (browserAvailable ? "browser" : undefined);
      const nextDomain = focusedInput
        ? cycleContentSearchDomain(current.domain, browserAvailable)
        : resolveContentSearchDomain(preferredDomain, current.domain, browserAvailable);
      const selectionSeed = readSingleLineSelectionText(window.getSelection?.()?.toString());
      return {
        ...current,
        open: true,
        domain: nextDomain,
        queryByDomain: selectionSeed
          ? {
              ...current.queryByDomain,
              [nextDomain]: selectionSeed,
            }
          : current.queryByDomain,
      };
    });
    focusContentSearchInput();
  }, []);

  const close = useCallback(() => {
    activeEnsureAbortRef.current?.abort();
    activeEnsureAbortRef.current = null;
    for (const source of sourcesRef.current.values()) {
      source.clear();
    }
    const target = browserTargetRef.current;
    if (target?.available) {
      void target.command({ type: "close-find", ...browserTargetIdentity(target) });
    }
    setState((current) => ({
      ...current,
      open: false,
      loadingDomain: null,
    }));
  }, []);

  const setDomain = useCallback((domain: ContentSearchDomain) => {
    if (domain === "browser" && !browserTargetRef.current?.available) return;
    setState((current) => ({ ...current, domain }));
    focusContentSearchInput();
  }, []);

  const setQuery = useCallback(
    (query: string) => {
      const domain = state.domain;
      if (isLocalDomain(domain)) {
        activeEnsureAbortRef.current?.abort();
        sourcesRef.current.get(domain)?.clear();
      }

      setState((current) => {
        if (!isLocalDomain(current.domain)) {
          return {
            ...current,
            queryByDomain: {
              ...current.queryByDomain,
              [current.domain]: query,
            },
          };
        }

        const normalizedQuery = normalizeContentSearchQuery(query);
        return {
          ...current,
          queryByDomain: {
            ...current.queryByDomain,
            [current.domain]: query,
          },
          loadingDomain: normalizedQuery ? current.domain : null,
          activeIndexByDomain: {
            ...current.activeIndexByDomain,
            [current.domain]: 0,
          },
          resultByDomain: {
            ...current.resultByDomain,
            [current.domain]: normalizedQuery
              ? {
                  query: normalizedQuery,
                  matches: [],
                  totalMatches: 0,
                  capped: false,
                }
              : null,
          },
        };
      });
    },
    [state.domain],
  );

  const stepLocal = useCallback((domain: ContentSearchLocalDomain, delta: -1 | 1) => {
    setState((current) => {
      const storedMatches = current.resultByDomain[domain]?.matches.length ?? 0;
      if (storedMatches <= 0) return current;
      const currentIndex = current.activeIndexByDomain[domain] ?? 0;
      const nextIndex = (currentIndex + delta + storedMatches) % storedMatches;
      return {
        ...current,
        activeIndexByDomain: {
          ...current.activeIndexByDomain,
          [domain]: nextIndex,
        },
      };
    });
  }, []);

  const goNext = useCallback(() => {
    const domain = state.domain;
    if (domain === "browser") {
      const target = browserTargetRef.current;
      if (target?.available) {
        void target.command({ type: "find-next", ...browserTargetIdentity(target) });
      }
      return;
    }
    stepLocal(domain, 1);
  }, [state.domain, stepLocal]);

  const goPrevious = useCallback(() => {
    const domain = state.domain;
    if (domain === "browser") {
      const target = browserTargetRef.current;
      if (target?.available) {
        void target.command({ type: "find-previous", ...browserTargetIdentity(target) });
      }
      return;
    }
    stepLocal(domain, -1);
  }, [state.domain, stepLocal]);

  const registerLocalSource = useCallback((source: ContentSearchLocalSource) => {
    sourcesRef.current.set(source.domain, source);
    setSourceVersion((version) => version + 1);
    return () => {
      if (sourcesRef.current.get(source.domain) !== source) return;
      source.clear();
      sourcesRef.current.delete(source.domain);
      setSourceVersion((version) => version + 1);
    };
  }, []);

  const registerBrowserTarget = useCallback((target: ContentSearchBrowserTarget) => {
    browserTargetRef.current = target;
    setBrowserTarget(target);
    return () => {
      if (browserTargetRef.current !== target) return;
      browserTargetRef.current = null;
      setBrowserTarget(null);
    };
  }, []);

  useEffect(() => {
    if (
      !openRequest ||
      openRequest.tick <= 0 ||
      openRequest.tick === lastOpenRequestTickRef.current
    )
      return;
    lastOpenRequestTickRef.current = openRequest.tick;
    requestOpen(openRequest);
  }, [openRequest, requestOpen]);

  useEffect(() => {
    const previousDomain = lastDomainRef.current;
    if (previousDomain !== state.domain) {
      clearDomain(previousDomain);
    }
    lastDomainRef.current = state.domain;
  }, [clearDomain, state.domain]);

  useEffect(() => {
    if (state.domain !== "browser" || hasBrowserTarget) return;
    setState((current) => ({
      ...current,
      domain: "conversation",
    }));
  }, [hasBrowserTarget, state.domain]);

  useEffect(() => {
    if (!state.open || state.domain !== "browser") return;
    const target = browserTargetRef.current;
    if (!target?.available) return;
    const query = state.queryByDomain.browser;
    void target.command({
      type: "set-find-query",
      ...browserTargetIdentity(target),
      query,
    });
  }, [state.domain, state.open, state.queryByDomain.browser, browserTarget]);

  useEffect(() => {
    if (!state.open || !isLocalDomain(state.domain)) return;
    const domain = state.domain;
    const source = sourcesRef.current.get(domain);
    const query = normalizeContentSearchQuery(state.queryByDomain[domain]);
    const sequence = searchSequenceRef.current + 1;
    searchSequenceRef.current = sequence;

    if (!source || !query) {
      source?.clear();
      setState((current) => ({
        ...current,
        loadingDomain: current.loadingDomain === domain ? null : current.loadingDomain,
        resultByDomain: {
          ...current.resultByDomain,
          [domain]: query ? { query, matches: [], totalMatches: 0, capped: false } : null,
        },
      }));
      return;
    }

    const controller = new AbortController();
    setState((current) => ({ ...current, loadingDomain: domain }));
    const timerId = window.setTimeout(() => {
      void Promise.resolve(
        source.search(query, CONTENT_SEARCH_LOCAL_MATCH_LIMIT, {
          signal: controller.signal,
        }),
      )
        .then((result) => {
          if (controller.signal.aborted || searchSequenceRef.current !== sequence) return;
          setState((current) => {
            const activeIndex = Math.min(
              current.activeIndexByDomain[domain] ?? 0,
              Math.max(result.matches.length - 1, 0),
            );
            return {
              ...current,
              loadingDomain: current.loadingDomain === domain ? null : current.loadingDomain,
              resultByDomain: {
                ...current.resultByDomain,
                [domain]: result,
              },
              activeIndexByDomain: {
                ...current.activeIndexByDomain,
                [domain]: activeIndex,
              },
            };
          });
        })
        .catch(() => {
          if (controller.signal.aborted || searchSequenceRef.current !== sequence) return;
          setState((current) => ({
            ...current,
            loadingDomain: current.loadingDomain === domain ? null : current.loadingDomain,
            resultByDomain: {
              ...current.resultByDomain,
              [domain]: { query, matches: [], totalMatches: 0, capped: false },
            },
          }));
        });
    }, CONTENT_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [sourceVersion, state.domain, state.open, state.queryByDomain]);

  useEffect(() => {
    if (!state.open || !isLocalDomain(state.domain)) return;
    const domain = state.domain;
    const source = sourcesRef.current.get(domain);
    const result = state.resultByDomain[domain];
    const liveQuery = normalizeContentSearchQuery(state.queryByDomain[domain]);
    const activeIndex = state.activeIndexByDomain[domain] ?? 0;
    const match = result?.matches[activeIndex] ?? null;
    if (
      !source ||
      !result ||
      result.query !== liveQuery ||
      state.loadingDomain === domain ||
      !match
    ) {
      source?.clear();
      return;
    }
    activeEnsureAbortRef.current?.abort();
    const controller = new AbortController();
    activeEnsureAbortRef.current = controller;

    void (async () => {
      try {
        source.publishResult?.(result, match.id);
        await source.ensureVisible?.(match, { signal: controller.signal });
        if (controller.signal.aborted) return;
        await source.activate(match, result.query, {
          signal: controller.signal,
        });
      } catch {
        if (!controller.signal.aborted) {
          source.clear();
        }
      }
    })();
    return () => {
      controller.abort();
      if (activeEnsureAbortRef.current === controller) {
        activeEnsureAbortRef.current = null;
      }
    };
  }, [
    state.activeIndexByDomain,
    state.domain,
    state.loadingDomain,
    state.open,
    state.queryByDomain,
    state.resultByDomain,
    sourceVersion,
  ]);

  const labelInput: ContentSearchLabelInput = {
    domain: state.domain,
    query: state.queryByDomain[state.domain],
    loading: isLocalDomain(state.domain) && state.loadingDomain === state.domain,
    activeIndex: isLocalDomain(state.domain) ? state.activeIndexByDomain[state.domain] : 0,
    localResult: isLocalDomain(state.domain) ? state.resultByDomain[state.domain] : null,
    browserFindState: browserTarget?.findState ?? null,
  };
  const resultLabel = buildContentSearchResultLabel(labelInput);
  const navigationDisabled = !canNavigateContentSearchMatches(labelInput);

  const controller = useMemo<ContentSearchController>(
    () => ({
      state,
      hasBrowserTarget,
      browserFindState: browserTarget?.findState ?? null,
      resultLabel,
      navigationDisabled,
      requestOpen,
      close,
      setDomain,
      setQuery,
      goNext,
      goPrevious,
      registerLocalSource,
      registerBrowserTarget,
    }),
    [
      browserTarget?.findState,
      close,
      goNext,
      goPrevious,
      hasBrowserTarget,
      navigationDisabled,
      registerBrowserTarget,
      registerLocalSource,
      requestOpen,
      resultLabel,
      setDomain,
      setQuery,
      state,
    ],
  );

  return (
    <ContentSearchContext.Provider value={controller}>{children}</ContentSearchContext.Provider>
  );
}

export function useContentSearch(): ContentSearchController {
  const context = useContext(ContentSearchContext);
  if (!context) {
    throw new Error("useContentSearch must be used inside ContentSearchProvider");
  }
  return context;
}

export function useContentSearchOptional(): ContentSearchController | null {
  return useContext(ContentSearchContext);
}

export function useRegisterContentSearchSource(source: ContentSearchLocalSource | null): void {
  const context = useContentSearchOptional();
  const registerLocalSource = context?.registerLocalSource;
  useEffect(() => {
    if (!registerLocalSource || !source) return undefined;
    return registerLocalSource(source);
  }, [registerLocalSource, source]);
}

export function useRegisterContentSearchBrowserTarget(
  target: ContentSearchBrowserTarget | null,
): void {
  const context = useContentSearchOptional();
  const registerBrowserTarget = context?.registerBrowserTarget;
  useEffect(() => {
    if (!registerBrowserTarget || !target) return undefined;
    return registerBrowserTarget(target);
  }, [registerBrowserTarget, target]);
}
