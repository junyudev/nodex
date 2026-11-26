import { beginWorkbenchFocus, returnWorkbenchFocus } from "@/lib/workbench-focus-landing";
import { registerContentSearchNavigation } from "./content-search-keyboard";
import { useIntl } from "@/lib/i18n";
import type { WorkbenchChatSearchRequest } from "@/lib/workbench-surface-reveal";
import type { PageSearchReveal } from "@/lib/page-search-reveal";
import type { ChatSearchReveal } from "@/lib/chat-search-reveal";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
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
  type ContentSearchOpenOptions,
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
  readyForChatReveal?: boolean;
  isFocused?: () => boolean;
  findHost?: () => HTMLElement | null;
  /** Content changes invalidate results without making editor transactions own Find state. */
  subscribe?: (listener: () => void) => () => void;
  replace?: { current: (text: string) => void; all: (text: string) => void };
  search: (
    query: string,
    limit: number,
    options?: { signal: AbortSignal; reveal?: ChatSearchReveal; pageReveal?: PageSearchReveal },
  ) => Promise<ContentSearchLocalResult> | ContentSearchLocalResult;
  ensureVisible?: (
    match: ContentSearchLocalMatch,
    options: { signal: AbortSignal },
  ) => Promise<void> | void;
  /** Publish retained identities before navigation; DOM maintenance never starts another search. */
  publishResult?: (result: ContentSearchLocalResult, activeMatchId: string) => void;
  /**
   * Marks the active match. `reveal: false` follows a `subscribe` refresh: the person is working
   * in the surface, so Find keeps its view, focus and selection where they are.
   */
  activate: (
    match: ContentSearchLocalMatch,
    query: string,
    options?: { signal: AbortSignal; reveal?: boolean },
  ) => Promise<void> | void;
  /** Leaving Find from its bar returns focus to the surface at the active match. */
  returnFocus?: () => void;
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
  pageContextId: string | null;
  pageReveal: PageSearchReveal | null;
  chatTarget: { readonly sessionId: string; readonly target: ChatSearchReveal } | null;
  /** Counts Find intents; only these move the view to the active match. */
  revealIntent: number;
}

export interface ContentSearchController {
  state: ContentSearchState;
  hasBrowserTarget: boolean;
  hasPageTarget: boolean;
  findHost?: () => HTMLElement | null;
  canReplace: boolean;
  replaceCurrent: (text: string) => void;
  replaceAll: (text: string) => void;
  browserFindState: BrowserSidebarFindState | null;
  resultLabel: string;
  navigationDisabled: boolean;
  requestOpen: (request?: ContentSearchOpenOptions) => void;
  close: (options?: { returnFocus?: boolean }) => void;
  setDomain: (domain: ContentSearchDomain) => void;
  setQuery: (query: string) => void;
  goNext: () => void;
  goPrevious: () => void;
  registerLocalSource: (source: ContentSearchLocalSource) => () => void;
  registerBrowserTarget: (target: ContentSearchBrowserTarget) => () => void;
}

const EMPTY_LOCAL_RESULTS: Record<ContentSearchLocalDomain, ContentSearchLocalResult | null> = {
  page: null,
  conversation: null,
  diff: null,
};

const EMPTY_ACTIVE_INDEX: Record<ContentSearchLocalDomain, number> = {
  page: 0,
  conversation: 0,
  diff: 0,
};

const EMPTY_QUERY_BY_DOMAIN: Record<ContentSearchDomain, string> = {
  page: "",
  conversation: "",
  diff: "",
  browser: "",
};

const ContentSearchContext = createContext<ContentSearchController | null>(null);

/** Resolves true once the match is active; a reveal also brings it into view first. */
async function activateLocalMatch(
  source: ContentSearchLocalSource,
  result: ContentSearchLocalResult,
  match: ContentSearchLocalMatch,
  signal: AbortSignal,
  reveal: boolean,
): Promise<boolean> {
  try {
    source.publishResult?.(result, match.id);
    if (reveal) await source.ensureVisible?.(match, { signal });
    if (signal.aborted) return false;
    await source.activate(match, result.query, { signal, reveal });
    return !signal.aborted;
  } catch {
    if (!signal.aborted) source.clear();
    return false;
  }
}

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

interface ContentSearchRequests {
  openRequest?: ContentSearchOpenRequest | null;
  chatReveal?: WorkbenchChatSearchRequest;
  chatSessionId?: string | null;
}

const ContentSearchRequestsContext = createContext<Dispatch<
  SetStateAction<ContentSearchRequests>
> | null>(null);

/** Workbench navigation sends its intents to the window's Find owner. */
export function ContentSearchWorkbenchRequests({
  openRequest,
  chatReveal,
  chatSessionId,
}: ContentSearchRequests) {
  const setRequests = useContext(ContentSearchRequestsContext);
  useEffect(() => {
    setRequests?.({ openRequest, chatReveal, chatSessionId });
  }, [setRequests, openRequest, chatReveal, chatSessionId]);
  useEffect(() => () => setRequests?.({}), [setRequests]);
  return null;
}

export function ContentSearchProvider({
  children,
  openRequest: suppliedOpenRequest,
  chatReveal: suppliedChatReveal,
  chatSessionId: suppliedChatSessionId,
}: {
  children: ReactNode;
} & ContentSearchRequests) {
  const [requests, setRequests] = useState<ContentSearchRequests>({});
  const openRequest = suppliedOpenRequest ?? requests.openRequest ?? null;
  const chatReveal = suppliedChatReveal ?? requests.chatReveal;
  const chatSessionId = suppliedChatSessionId ?? requests.chatSessionId ?? null;
  const intl = useIntl();
  const sourcesRef = useRef(new Set<ContentSearchLocalSource>());
  const browserTargetRef = useRef<ContentSearchBrowserTarget | null>(null);
  const searchSequenceRef = useRef(0);
  const activeEnsureAbortRef = useRef<AbortController | null>(null);
  const lastOpenRequestTickRef = useRef(openRequest?.tick ?? 0);
  const lastChatRevealIdRef = useRef<string | null>(null);
  const lastDomainRef = useRef<ContentSearchDomain>("conversation");
  const activeSourceRef = useRef<ContentSearchLocalSource | undefined>(undefined);
  const revealedIntentRef = useRef(0);
  /** Tracks closing synchronously so effects from an earlier commit cannot revive a match. */
  const openRef = useRef(false);
  const [sources, setSources] = useState<readonly ContentSearchLocalSource[]>([]);
  const [browserTarget, setBrowserTarget] = useState<ContentSearchBrowserTarget | null>(null);
  const [state, setState] = useState<ContentSearchState>({
    open: false,
    domain: "conversation",
    queryByDomain: EMPTY_QUERY_BY_DOMAIN,
    activeIndexByDomain: EMPTY_ACTIVE_INDEX,
    resultByDomain: EMPTY_LOCAL_RESULTS,
    loadingDomain: null,
    pageContextId: null,
    pageReveal: null,
    chatTarget: null,
    revealIntent: 0,
  });

  const [sourceRevision, setSourceRevision] = useState(0);
  const hasPageTarget = sources.some((source) => source.domain === "page");
  const hasBrowserTarget = Boolean(browserTarget?.available);

  const clearDomain = useCallback((domain: ContentSearchDomain) => {
    if (!isLocalDomain(domain)) return;
    for (const source of sourcesRef.current) {
      if (source.domain === domain) source.clear();
    }
  }, []);

  const requestOpen = useCallback((request?: ContentSearchOpenOptions) => {
    setState((current) => {
      const focusedInput = document.activeElement?.id === CONTENT_SEARCH_INPUT_ID;
      const browserAvailable = Boolean(browserTargetRef.current?.available);
      const focusedSource = [...sourcesRef.current].findLast((source) => source.isFocused?.());
      const preferredDomain =
        request?.preferredDomain ??
        focusedSource?.domain ??
        (browserAvailable ? "browser" : undefined);
      const nextDomain =
        focusedInput && !request?.contextId
          ? cycleContentSearchDomain(
              current.domain,
              browserAvailable,
              [...sourcesRef.current].some((source) => source.domain === "page"),
            )
          : resolveContentSearchDomain(preferredDomain, current.domain, browserAvailable);
      const selectionSeed =
        request?.query ?? readSingleLineSelectionText(window.getSelection?.()?.toString());
      return {
        ...current,
        open: true,
        domain: nextDomain,
        pageContextId:
          request?.contextId ??
          (focusedSource?.domain === "page" ? focusedSource.contextId : current.pageContextId),
        pageReveal: request?.pageReveal ?? null,
        chatTarget: null,
        queryByDomain:
          selectionSeed !== null && selectionSeed !== undefined
            ? {
                ...current.queryByDomain,
                [nextDomain]: selectionSeed,
              }
            : current.queryByDomain,
      };
    });
    focusContentSearchInput();
  }, []);

  const close = useCallback((options?: { returnFocus?: boolean }) => {
    openRef.current = false;
    activeEnsureAbortRef.current?.abort();
    activeEnsureAbortRef.current = null;
    const activeDomain = lastDomainRef.current;
    if (options?.returnFocus && activeDomain !== "browser")
      activeSourceRef.current?.returnFocus?.();
    for (const source of sourcesRef.current.values()) {
      source.clear();
    }
    const target = browserTargetRef.current;
    if (target?.available) {
      if (options?.returnFocus && activeDomain === "browser") {
        const browserTabId = CSS.escape(target.browserTabId);
        const guest = document.querySelector<HTMLElement>(
          `[data-browser-sidebar-webview-visible="true"] webview[data-browser-sidebar-browser-tab-id="${browserTabId}"]`,
        );
        returnWorkbenchFocus(guest, beginWorkbenchFocus());
      }
      void target.command({ type: "close-find", ...browserTargetIdentity(target) });
    }
    setState((current) => ({
      ...current,
      open: false,
      loadingDomain: null,
      chatTarget: null,
      pageReveal: null,
    }));
  }, []);

  const setDomain = useCallback((domain: ContentSearchDomain) => {
    if (domain === "browser" && !browserTargetRef.current?.available) return;
    setState((current) => ({ ...current, domain, chatTarget: null, pageReveal: null }));
    focusContentSearchInput();
  }, []);

  const setQuery = useCallback(
    (query: string) => {
      const domain = state.domain;
      if (isLocalDomain(domain)) {
        activeEnsureAbortRef.current?.abort();
        clearDomain(domain);
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
          chatTarget: null,
          pageReveal: null,
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
    [clearDomain, state.domain],
  );

  const stepLocal = useCallback((domain: ContentSearchLocalDomain, delta: -1 | 1) => {
    setState((current) => {
      const storedMatches = current.resultByDomain[domain]?.matches.length ?? 0;
      if (storedMatches <= 0) return current;
      const currentIndex = current.activeIndexByDomain[domain] ?? 0;
      const nextIndex =
        currentIndex < 0
          ? delta === 1
            ? 0
            : storedMatches - 1
          : (currentIndex + delta + storedMatches) % storedMatches;
      return {
        ...current,
        revealIntent: current.revealIntent + 1,
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
    sourcesRef.current.add(source);
    setSources([...sourcesRef.current]);
    return () => {
      if (!sourcesRef.current.delete(source)) return;
      source.clear();
      setSources([...sourcesRef.current]);
      setState((current) =>
        current.pageContextId === source.contextId
          ? { ...current, pageContextId: null, pageReveal: null }
          : current,
      );
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

  if (state.domain === "browser" && !hasBrowserTarget) {
    setState({ ...state, domain: "conversation" });
  }

  useEffect(() => {
    if (!state.open || state.domain !== "browser") return;
    const target = browserTarget;
    if (!target?.available) return;
    const query = state.queryByDomain.browser;
    void target.command({
      type: "set-find-query",
      ...browserTargetIdentity(target),
      query,
    });
  }, [state.domain, state.open, state.queryByDomain.browser, browserTarget]);

  useEffect(() => {
    if (!chatReveal || !chatSessionId || chatReveal.operationId === lastChatRevealIdRef.current)
      return;
    lastChatRevealIdRef.current = chatReveal.operationId;
    activeEnsureAbortRef.current?.abort();
    setState((current) => ({
      ...current,
      open: true,
      domain: "conversation",
      queryByDomain: { ...current.queryByDomain, conversation: chatReveal.target.text },
      resultByDomain: { ...current.resultByDomain, conversation: null },
      activeIndexByDomain: { ...current.activeIndexByDomain, conversation: 0 },
      loadingDomain: "conversation",
      chatTarget: { sessionId: chatSessionId, target: chatReveal.target },
    }));
    chatReveal.consume();
    focusContentSearchInput();
  }, [chatReveal, chatSessionId]);

  if (state.chatTarget && state.chatTarget.sessionId !== chatSessionId)
    setState({ ...state, chatTarget: null });

  const query = normalizeContentSearchQuery(state.queryByDomain[state.domain]);
  const chatTarget = state.domain === "conversation" ? state.chatTarget : null;
  const reveal = chatTarget?.target;
  const source = sources.findLast(
    (candidate) =>
      candidate.domain === state.domain &&
      (state.domain !== "page" ||
        !state.pageContextId ||
        candidate.contextId === state.pageContextId) &&
      (!reveal ||
        (candidate.contextId === `conversation:${reveal.threadId}` &&
          candidate.readyForChatReveal)),
  );
  const [localSearchInput, setLocalSearchInput] = useState({
    domain: state.domain,
    open: state.open,
    query,
    source,
    chatTarget,
    pageReveal: state.pageReveal,
    sourceRevision,
  });
  const searchIntentChanged =
    localSearchInput.domain !== state.domain ||
    localSearchInput.open !== state.open ||
    localSearchInput.query !== query ||
    localSearchInput.source !== source ||
    localSearchInput.chatTarget !== chatTarget ||
    localSearchInput.pageReveal !== state.pageReveal;
  if (searchIntentChanged || localSearchInput.sourceRevision !== sourceRevision) {
    const nextInput = {
      domain: state.domain,
      open: state.open,
      query,
      source,
      chatTarget,
      pageReveal: state.pageReveal,
      sourceRevision,
    };
    setLocalSearchInput(nextInput);
    const { domain, open } = nextInput;
    // A content refresh keeps the current result and view until the new one arrives.
    if (open && isLocalDomain(domain) && searchIntentChanged) {
      setState((current) => ({
        ...current,
        revealIntent: current.revealIntent + 1,
        loadingDomain:
          (source || reveal) && query
            ? domain
            : current.loadingDomain === domain
              ? null
              : current.loadingDomain,
        resultByDomain:
          source && query
            ? current.resultByDomain
            : {
                ...current.resultByDomain,
                [domain]: query ? { query, matches: [], totalMatches: 0, capped: false } : null,
              },
      }));
    }
  }
  useEffect(() => {
    const { domain, open, source, query, chatTarget, pageReveal } = localSearchInput;
    const reveal = chatTarget?.target;
    if (!open || !isLocalDomain(domain)) return;
    const sequence = searchSequenceRef.current + 1;
    searchSequenceRef.current = sequence;
    if (!source || !query) {
      source?.clear();
      return;
    }

    const controller = new AbortController();
    const timerId = window.setTimeout(() => {
      void Promise.resolve(
        source.search(query, CONTENT_SEARCH_LOCAL_MATCH_LIMIT, {
          signal: controller.signal,
          ...(reveal ? { reveal } : {}),
          ...(pageReveal ? { pageReveal } : {}),
        }),
      )
        .then((result) => {
          if (controller.signal.aborted || searchSequenceRef.current !== sequence) return;
          setState((current) => {
            const activeIndex =
              result.preferredMatchId === undefined
                ? Math.max(
                    0,
                    Math.min(current.activeIndexByDomain[domain] ?? 0, result.matches.length - 1),
                  )
                : result.matches.findIndex((match) => match.id === result.preferredMatchId);
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
  }, [localSearchInput]);

  useLayoutEffect(() => {
    openRef.current = state.open;
  }, [state.open]);

  useEffect(() => {
    if (!state.open || !openRef.current || !isLocalDomain(state.domain)) return;
    const domain = state.domain;
    const result = state.resultByDomain[domain];
    const liveQuery = normalizeContentSearchQuery(state.queryByDomain[domain]);
    const activeIndex = state.activeIndexByDomain[domain] ?? 0;
    const match = result?.matches[activeIndex] ?? null;
    if (!source || !result || result.query !== liveQuery || state.loadingDomain === domain) {
      source?.clear();
      return;
    }
    const intent = state.revealIntent;
    if (match?.contextId !== source.contextId || !match) {
      revealedIntentRef.current = intent;
      source.clear();
      return;
    }
    const reveal = intent !== revealedIntentRef.current;
    activeEnsureAbortRef.current?.abort();
    const controller = new AbortController();
    activeEnsureAbortRef.current = controller;

    void activateLocalMatch(source, result, match, controller.signal, reveal).then((settled) => {
      if (settled) revealedIntentRef.current = intent;
    });
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
    state.revealIntent,
    source,
  ]);

  useEffect(() => {
    activeSourceRef.current = source;
  }, [source]);

  useEffect(() => {
    if (!state.open || !query) return;
    return source?.subscribe?.(() => setSourceRevision((revision) => revision + 1));
  }, [source, state.open, query]);

  useEffect(() => () => source?.clear(), [source]);

  const replaceCurrent = useCallback((text: string) => source?.replace?.current(text), [source]);
  const replaceAll = useCallback((text: string) => source?.replace?.all(text), [source]);

  const labelInput: ContentSearchLabelInput = {
    domain: state.domain,
    query: state.queryByDomain[state.domain],
    loading: isLocalDomain(state.domain) && state.loadingDomain === state.domain,
    activeIndex: isLocalDomain(state.domain) ? state.activeIndexByDomain[state.domain] : 0,
    localResult: isLocalDomain(state.domain) ? state.resultByDomain[state.domain] : null,
    browserFindState: browserTarget?.findState ?? null,
  };
  const resultLabel = buildContentSearchResultLabel(labelInput, intl);
  const navigationDisabled = !canNavigateContentSearchMatches(labelInput);

  useEffect(
    () =>
      registerContentSearchNavigation((direction) => {
        if (!state.open) return false;
        if (!navigationDisabled) {
          if (direction === "previous") goPrevious();
          else goNext();
        }
        return true;
      }),
    [state.open, navigationDisabled, goPrevious, goNext],
  );

  const controller = useMemo<ContentSearchController>(
    () => ({
      state,
      hasBrowserTarget,
      hasPageTarget,
      findHost: source?.findHost,
      canReplace: Boolean(source?.replace),
      replaceCurrent,
      replaceAll,
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
      hasPageTarget,
      source,
      replaceCurrent,
      replaceAll,
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
    <ContentSearchRequestsContext.Provider value={setRequests}>
      <ContentSearchContext.Provider value={controller}>{children}</ContentSearchContext.Provider>
    </ContentSearchRequestsContext.Provider>
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
