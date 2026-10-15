import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CloseIcon, PageIcon, PlusIcon, SearchIcon } from "@/components/shared/icons";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import {
  readRelationValuePreview,
  type RelationCandidateWindow,
  type RelationTargetPreview,
  type RelationTargetWindow,
  type RelationTargetWindowItem,
} from "@/lib/data-source-relation-value";
import { foldDataSourceRelationSearchText } from "@/lib/data-source-relation-runtime";
import { cn } from "@/lib/utils";
import {
  DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
  PropertyEmptyValue,
} from "./property-empty-value";
import {
  DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME,
  DATABASE_PAGE_PROPERTY_VALUE_TOKEN_CLASS_NAME,
  DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME,
  type DatabasePropertyValuePresentation,
} from "./property-value-chip";
import {
  configuredPageSearchProjectIds,
  useInteractivePageSearch,
} from "@/lib/interactive-page-search";

const mergeCandidates = (
  left: readonly { readonly pageId: string; readonly title: string }[],
  right: readonly { readonly pageId: string; readonly title: string }[],
) => {
  const byId = new Map(left.map((candidate) => [candidate.pageId, candidate]));
  for (const candidate of right) byId.set(candidate.pageId, candidate);
  return [...byId.values()];
};

const mergeTargets = (
  left: readonly RelationTargetWindowItem[],
  right: readonly RelationTargetWindowItem[],
) => {
  const edgeIds = new Set(left.map((target) => target.edgeId));
  return [...left, ...right.filter((target) => !edgeIds.has(target.edgeId))];
};

export type RelationPropertyEditorHost = "popover" | "embedded";

function RelationPropertyEditorContentFrame({
  host,
  children,
}: {
  readonly host: RelationPropertyEditorHost;
  readonly children: ReactNode;
}) {
  if (host === "embedded") {
    return <div className="w-full min-w-0 overflow-hidden">{children}</div>;
  }
  return (
    <NodexPopoverContent
      align="start"
      className="w-[min(360px,calc(100vw-16px))] overflow-hidden p-0"
    >
      {children}
    </NodexPopoverContent>
  );
}

export function RelationPropertyEditor({
  label,
  value,
  candidates,
  cardinality = "many",
  excludedPageId,
  disabled,
  pending = false,
  targetMatchesCurrentSource,
  targetDataSourceId,
  onPatch,
  onReplace,
  onClear,
  onLoadMore,
  onSearchCandidates,
  onLoadTargetDescriptor,
  onOpenPage,
  onValueStale,
  showLabel = true,
  presentation = "compact",
  triggerIcon,
  host = "popover",
  onRequestClose,
}: {
  readonly label: string;
  readonly value: unknown;
  readonly candidates: readonly { readonly pageId: string; readonly title: string }[];
  readonly cardinality?: "one" | "many";
  readonly excludedPageId?: string;
  readonly disabled: boolean;
  readonly pending?: boolean;
  readonly targetMatchesCurrentSource: boolean;
  readonly targetDataSourceId?: string;
  readonly onPatch: (delta: {
    readonly addPageIds: readonly string[];
    readonly removeEdgeIds: readonly string[];
  }) => void;
  readonly onReplace?: (targetPageId: string | null) => void;
  readonly onClear: () => void;
  readonly onLoadMore?: (after: string | null) => Promise<RelationTargetWindow>;
  readonly onSearchCandidates?: (
    query: string,
    after?: string | null,
  ) => Promise<RelationCandidateWindow>;
  readonly onLoadTargetDescriptor?: () => Promise<{ readonly name: string } | null>;
  readonly onOpenPage?: (pageId: string, title: string) => void;
  readonly onValueStale?: () => void;
  readonly showLabel?: boolean;
  readonly presentation?: DatabasePropertyValuePresentation;
  readonly triggerIcon?: ReactNode;
  readonly host?: RelationPropertyEditorHost;
  readonly onRequestClose?: () => void;
}) {
  const parsedPreview = readRelationValuePreview(value);
  const invalidPreview = value != null && parsedPreview === null;
  const preview = parsedPreview ?? {
    valueRevision: 0,
    totalCount: 0,
    targets: [],
    unavailableCount: 0,
    hasMore: false,
  };
  const [open, setOpen] = useState(false);
  const editorOpen = host === "embedded" || open;
  const closeEditor = () => {
    setOpen(false);
    onRequestClose?.();
  };
  const [query, setQuery] = useState("");
  const [targetName, setTargetName] = useState<string | null>(null);
  const [targetDescriptorLoaded, setTargetDescriptorLoaded] = useState(false);
  const [expandedTargets, setExpandedTargets] = useState<
    readonly RelationTargetWindowItem[] | null
  >(null);
  const [targetCursor, setTargetCursor] = useState<string | null>(null);
  const [targetProjectionRevision, setTargetProjectionRevision] = useState<number | null>(null);
  const [candidateResults, setCandidateResults] = useState<
    readonly {
      readonly pageId: string;
      readonly title: string;
    }[]
  >([]);
  const [candidateQuery, setCandidateQuery] = useState<string | null>(null);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [candidateProjectionRevision, setCandidateProjectionRevision] = useState<number | null>(
    null,
  );
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [searching, setSearching] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [activeCandidateIndex, setActiveCandidateIndex] = useState(0);
  const [candidateErrorQuery, setCandidateErrorQuery] = useState<string | null>(null);
  const [targetError, setTargetError] = useState(false);
  const [searchRetry, setSearchRetry] = useState(0);
  const targetGeneration = useRef(0);
  const descriptorGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchCandidatesRef = useRef(onSearchCandidates);
  const loadTargetDescriptorRef = useRef(onLoadTargetDescriptor);
  searchCandidatesRef.current = onSearchCandidates;
  loadTargetDescriptorRef.current = onLoadTargetDescriptor;
  const canSearchCandidates = onSearchCandidates !== undefined;
  const canLoadTargetDescriptor = onLoadTargetDescriptor !== undefined;
  const selectedHeadingId = useId();
  const candidateHeadingId = useId();
  const candidateListboxId = useId();
  const visibleTargets = (expandedTargets ?? preview.targets).filter(
    (target): target is RelationTargetPreview => target.kind === "visible",
  );
  const unavailableTargets =
    expandedTargets?.filter(
      (target): target is Extract<RelationTargetWindowItem, { readonly kind: "unavailable" }> =>
        target.kind === "unavailable",
    ) ?? [];
  const unloadedUnavailableCount = Math.max(
    0,
    preview.unavailableCount - unavailableTargets.length,
  );
  const selectedIds = new Set(visibleTargets.map((target) => target.pageId));
  const normalizedQuery = foldDataSourceRelationSearchText(query.trim());
  const metadataSearch = useInteractivePageSearch({
    projectIds: configuredPageSearchProjectIds(),
    query: normalizedQuery,
    dataSourceIds: targetDataSourceId ? [targetDataSourceId] : [],
    excludePageIds: excludedPageId ? [excludedPageId] : [],
    limit: 60,
    complete: false,
  });
  const metadataRows = editorOpen ? metadataSearch.rows : [];
  const synchronousCandidates = metadataRows.map((row) => ({
    pageId: row.pageId,
    title: row.title,
  }));
  const seedCandidates = targetMatchesCurrentSource
    ? candidates.filter(
        (candidate) =>
          !normalizedQuery ||
          foldDataSourceRelationSearchText(candidate.title).includes(normalizedQuery),
      )
    : [];
  const activeCandidateResults = candidateQuery === query ? candidateResults : [];
  const activeCandidateCursor = candidateQuery === query ? candidateCursor : null;
  const candidateError = candidateErrorQuery === query;
  const candidateSearchPending = searching;
  const available = mergeCandidates(
    mergeCandidates(seedCandidates, synchronousCandidates),
    activeCandidateResults,
  ).filter(
    (candidate) => candidate.pageId !== excludedPageId && !selectedIds.has(candidate.pageId),
  );
  const selectCandidate = (pageId: string) => {
    if (cardinality === "one") {
      if (!onReplace) return;
      onReplace(pageId);
      closeEditor();
      return;
    }
    onPatch({ addPageIds: [pageId], removeEdgeIds: [] });
  };

  useEffect(() => {
    setActiveCandidateIndex((current) => Math.min(current, Math.max(0, available.length - 1)));
  }, [available.length]);

  useEffect(() => {
    targetGeneration.current += 1;
    descriptorGeneration.current += 1;
    searchGeneration.current += 1;
    setExpandedTargets(null);
    setTargetCursor(null);
    setTargetProjectionRevision(null);
    setCandidateResults([]);
    setCandidateQuery(null);
    setCandidateCursor(null);
    setCandidateProjectionRevision(null);
    setLoadingTargets(false);
    setSearching(false);
    setConfirmingClear(false);
    setTargetName(null);
    setTargetDescriptorLoaded(false);
    setCandidateErrorQuery(null);
    setTargetError(false);
  }, [label, preview.valueRevision]);

  const readOnly = disabled || invalidPreview || (cardinality === "one" && onReplace === undefined);
  const actionDisabled = readOnly || pending;

  useEffect(() => {
    if (!readOnly) return;
    setOpen(false);
  }, [readOnly]);

  useEffect(() => {
    if (!editorOpen || !loadTargetDescriptorRef.current) return;
    const generation = ++descriptorGeneration.current;
    void loadTargetDescriptorRef
      .current()
      .then((descriptor) => {
        if (generation !== descriptorGeneration.current) return;
        setTargetName(descriptor?.name ?? null);
        setTargetDescriptorLoaded(true);
      })
      .catch(() => {
        if (generation !== descriptorGeneration.current) return;
        setTargetName(null);
        setTargetDescriptorLoaded(true);
      });
  }, [canLoadTargetDescriptor, editorOpen]);

  useEffect(() => {
    const searchCandidates = searchCandidatesRef.current;
    if (!editorOpen || !searchCandidates) return;
    const generation = ++searchGeneration.current;
    setSearching(true);
    setCandidateErrorQuery(null);
    void searchCandidates(query, null)
      .then((window) => {
        if (generation !== searchGeneration.current) return;
        setCandidateResults(window.candidates);
        setCandidateQuery(query);
        setCandidateCursor(window.nextCursor);
        setCandidateProjectionRevision(window.projectionRevision);
      })
      .catch((cause: unknown) => {
        if (generation !== searchGeneration.current) return;
        console.error("[relation-property:candidates]", cause);
        setCandidateResults([]);
        setCandidateQuery(null);
        setCandidateCursor(null);
        setCandidateErrorQuery(query);
      })
      .finally(() => {
        if (generation === searchGeneration.current) setSearching(false);
      });
  }, [canSearchCandidates, editorOpen, preview.valueRevision, query, searchRetry]);

  const loadSelectedTargets = () => {
    if (!onLoadMore || loadingTargets || readOnly) return;
    const generation = ++targetGeneration.current;
    setLoadingTargets(true);
    setTargetError(false);
    const after = expandedTargets === null ? null : targetCursor;
    const acceptWindow = (window: RelationTargetWindow, replace: boolean) => {
      if (generation !== targetGeneration.current) return false;
      if (window.valueRevision !== preview.valueRevision) {
        setExpandedTargets(null);
        setTargetCursor(null);
        setTargetError(false);
        onValueStale?.();
        return false;
      }
      setExpandedTargets((current) =>
        replace || current === null ? window.targets : mergeTargets(current, window.targets),
      );
      setTargetCursor(window.nextCursor);
      setTargetProjectionRevision(window.projectionRevision);
      return true;
    };
    void onLoadMore(after)
      .then(async (window) => {
        if (generation !== targetGeneration.current) return;
        if (
          after !== null &&
          targetProjectionRevision !== null &&
          window.projectionRevision !== targetProjectionRevision
        ) {
          const refreshed = await onLoadMore(null);
          acceptWindow(refreshed, true);
          return;
        }
        acceptWindow(window, after === null);
      })
      .catch(async (cause: unknown) => {
        if (generation !== targetGeneration.current) return;
        if (after === null) {
          console.error("[relation-property:selected]", cause);
          setTargetError(true);
          return;
        }
        try {
          const refreshed = await onLoadMore(null);
          acceptWindow(refreshed, true);
        } catch (refreshError) {
          if (generation === targetGeneration.current) {
            console.error("[relation-property:selected]", refreshError);
            setTargetError(true);
          }
        }
      })
      .finally(() => {
        if (generation === targetGeneration.current) setLoadingTargets(false);
      });
  };

  const loadMoreCandidates = () => {
    if (!onSearchCandidates || !activeCandidateCursor || searching || readOnly) return;
    const generation = searchGeneration.current;
    setSearching(true);
    const acceptFirstWindow = (window: RelationCandidateWindow) => {
      if (generation !== searchGeneration.current) return;
      setCandidateResults(window.candidates);
      setCandidateQuery(query);
      setCandidateCursor(window.nextCursor);
      setCandidateProjectionRevision(window.projectionRevision);
      setCandidateErrorQuery(null);
    };
    const refreshFirstWindow = async () => {
      const refreshed = await onSearchCandidates(query, null);
      acceptFirstWindow(refreshed);
    };
    void onSearchCandidates(query, activeCandidateCursor)
      .then(async (window) => {
        if (generation !== searchGeneration.current) return;
        if (
          candidateProjectionRevision !== null &&
          window.projectionRevision !== candidateProjectionRevision
        ) {
          setCandidateCursor(null);
          await refreshFirstWindow();
          return;
        }
        setCandidateResults((current) => mergeCandidates(current, window.candidates));
        setCandidateCursor(window.nextCursor);
      })
      .catch(async (cause: unknown) => {
        if (generation !== searchGeneration.current) return;
        try {
          await refreshFirstWindow();
        } catch (refreshError) {
          if (generation === searchGeneration.current) {
            console.error("[relation-property:candidates]", cause, refreshError);
            setCandidateErrorQuery(query);
          }
        }
      })
      .finally(() => {
        if (generation === searchGeneration.current) setSearching(false);
      });
  };

  const editor = (
    <NodexPopover
      open={editorOpen}
      onOpenChange={(next) => {
        if (host === "embedded") return;
        if (next && actionDisabled) return;
        setOpen(next);
        if (!next) {
          searchGeneration.current += 1;
          targetGeneration.current += 1;
          descriptorGeneration.current += 1;
          setSearching(false);
          setLoadingTargets(false);
          setQuery("");
          setConfirmingClear(false);
        }
      }}
    >
      {host === "popover" ? (
        <NodexPopoverTrigger disabled={actionDisabled}>
          <button
            type="button"
            aria-label={`Edit ${label} relation`}
            className={cn(
              "inline-flex min-h-6 min-w-0 max-w-full flex-wrap items-center gap-1 rounded-md text-left outline-hidden",
              "focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:opacity-50",
              presentation === "page"
                ? cn(
                    "group/relation-trigger text-sm",
                    preview.totalCount === 0 &&
                      !invalidPreview &&
                      DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
                  )
                : presentation === "list" || presentation === "board"
                  ? DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME
                  : "px-1 text-[11px] hover:bg-token-foreground/5",
            )}
          >
            {(presentation === "list" || presentation === "board") && preview.totalCount > 0
              ? triggerIcon
              : null}
            {visibleTargets.slice(0, 3).map((target) => (
              <span
                key={target.pageId}
                className={cn(
                  "inline-flex min-w-0 max-w-36 items-center gap-1",
                  presentation === "list" || presentation === "board"
                    ? "text-[var(--database-property-chip-current-text,var(--database-property-chip-text))]"
                    : "text-token-text-secondary",
                  presentation !== "list" &&
                    presentation !== "board" &&
                    (presentation === "page"
                      ? cn(
                          DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME,
                          "gap-1 group-hover/relation-trigger:bg-token-foreground/5",
                        )
                      : cn(
                          DATABASE_PAGE_PROPERTY_VALUE_TOKEN_CLASS_NAME,
                          "gap-1 bg-token-foreground/8",
                        )),
                )}
              >
                {presentation !== "list" && presentation !== "board" ? (
                  <PageIcon className="icon-2xs shrink-0" />
                ) : null}
                <span className="truncate">{target.title || "Untitled"}</span>
              </span>
            ))}
            {preview.unavailableCount > 0 ? (
              <span className="text-token-description-foreground">
                {preview.unavailableCount} unavailable
              </span>
            ) : null}
            {preview.totalCount > visibleTargets.slice(0, 3).length + preview.unavailableCount ? (
              <span className="text-token-description-foreground">
                +{preview.totalCount - visibleTargets.slice(0, 3).length - preview.unavailableCount}
              </span>
            ) : null}
            {invalidPreview ? (
              <span className="text-token-error-foreground">Invalid relation value</span>
            ) : preview.totalCount === 0 ? (
              <PropertyEmptyValue />
            ) : null}
            {preview.totalCount > 0 && presentation !== "list" && presentation !== "board" ? (
              <PlusIcon className="icon-2xs shrink-0 text-token-description-foreground mr-1" />
            ) : null}
          </button>
        </NodexPopoverTrigger>
      ) : null}
      <RelationPropertyEditorContentFrame host={host}>
        <div className="px-2 pb-1 pt-2">
          <div className="flex h-8 items-center gap-1.5 rounded-lg bg-token-foreground/5 px-2">
            <SearchIcon className="icon-2xs shrink-0 text-token-description-foreground" />
            <input
              ref={searchInputRef}
              autoFocus
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={editorOpen}
              aria-controls={candidateListboxId}
              aria-activedescendant={
                available[activeCandidateIndex]
                  ? `${candidateListboxId}-${activeCandidateIndex}`
                  : undefined
              }
              aria-label={`Search ${label} target pages`}
              value={query}
              disabled={readOnly}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeEditor();
                  return;
                }
                if (event.key === "Home") {
                  event.preventDefault();
                  if (available.length > 0) setActiveCandidateIndex(0);
                  return;
                }
                if (event.key === "End") {
                  event.preventDefault();
                  if (available.length > 0) {
                    setActiveCandidateIndex(available.length - 1);
                  }
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  if (available.length === 0) return;
                  setActiveCandidateIndex((current) => Math.min(available.length - 1, current + 1));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveCandidateIndex((current) => Math.max(0, current - 1));
                  return;
                }
                if (event.key !== "Enter") return;
                event.preventDefault();
                const candidate = available[activeCandidateIndex];
                if (!candidate || actionDisabled) return;
                selectCandidate(candidate.pageId);
              }}
              placeholder="Search pages…"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-token-foreground outline-hidden placeholder:text-token-description-foreground"
            />
          </div>
          <p className="mt-1 truncate px-1 text-xs text-token-description-foreground">
            {targetName
              ? `In ${targetName}`
              : targetDescriptorLoaded
                ? "Target source unavailable"
                : "Target source"}
          </p>
        </div>
        <div className="h-px bg-token-foreground/8" />
        <div className="max-h-[320px] overflow-y-auto p-1">
          {visibleTargets.length > 0 ||
          preview.unavailableCount > 0 ||
          (expandedTargets === null ? preview.hasMore : targetCursor !== null) ? (
            <section aria-labelledby={selectedHeadingId}>
              <h3
                id={selectedHeadingId}
                className="px-2 py-1 text-xs text-token-description-foreground"
              >
                Selected
              </h3>
              {visibleTargets.map((target) => (
                <div
                  key={target.pageId}
                  className="group flex min-h-8 items-center gap-2 rounded-lg px-2 hover:bg-token-list-hover-background"
                >
                  <PageIcon className="icon-xs shrink-0 text-token-text-secondary" />
                  {onOpenPage ? (
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-sm text-token-text-primary outline-hidden"
                      disabled={readOnly}
                      onClick={() => {
                        if (readOnly) return;
                        onOpenPage(target.pageId, target.title);
                      }}
                    >
                      {target.title || "Untitled"}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm text-token-text-primary">
                      {target.title || "Untitled"}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${target.title || "Untitled"}`}
                    disabled={actionDisabled}
                    onClick={() => {
                      if (actionDisabled) return;
                      if (cardinality === "one" && onReplace) {
                        onReplace(null);
                        closeEditor();
                        return;
                      }
                      onPatch({ addPageIds: [], removeEdgeIds: [target.edgeId] });
                    }}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-token-description-foreground opacity-70 hover:bg-token-foreground/10 hover:text-token-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <CloseIcon className="icon-xxs" />
                  </button>
                </div>
              ))}
              {unavailableTargets.map((target, index) => (
                <div
                  key={target.edgeId}
                  className="group flex min-h-8 items-center gap-2 rounded-lg px-2 hover:bg-token-list-hover-background"
                >
                  <PageIcon className="icon-xs shrink-0 text-token-description-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm text-token-description-foreground">
                    Unavailable page
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove unavailable page ${index + 1}`}
                    disabled={actionDisabled}
                    onClick={() => {
                      if (actionDisabled) return;
                      if (cardinality === "one" && onReplace) {
                        onReplace(null);
                        closeEditor();
                        return;
                      }
                      onPatch({ addPageIds: [], removeEdgeIds: [target.edgeId] });
                    }}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-token-description-foreground opacity-70 hover:bg-token-foreground/10 hover:text-token-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <CloseIcon className="icon-xxs" />
                  </button>
                </div>
              ))}
              {unloadedUnavailableCount > 0 ? (
                <p className="px-2 py-1 text-xs text-token-description-foreground">
                  {unloadedUnavailableCount} more unavailable{" "}
                  {unloadedUnavailableCount === 1 ? "page" : "pages"}
                </p>
              ) : null}
              {(expandedTargets === null ? preview.hasMore : targetCursor !== null) &&
              onLoadMore &&
              !targetError ? (
                <button
                  type="button"
                  disabled={readOnly || loadingTargets}
                  onClick={loadSelectedTargets}
                  className="flex min-h-7 w-full items-center rounded-lg px-2 text-left text-xs text-token-text-secondary hover:bg-token-list-hover-background disabled:opacity-50"
                >
                  {loadingTargets ? "Loading…" : "Load more selected"}
                </button>
              ) : null}
              {targetError && onLoadMore ? (
                <div role="alert" aria-atomic="true">
                  <button
                    type="button"
                    aria-label="Couldn’t load selected pages. Retry"
                    onClick={loadSelectedTargets}
                    className="flex min-h-7 w-full items-center justify-between rounded-lg px-2 text-left text-xs text-token-error-foreground hover:bg-token-error-background/20"
                  >
                    <span>Couldn’t load selected pages</span>
                    <span className="font-medium">Retry</span>
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
          <section aria-labelledby={candidateHeadingId}>
            <h3
              id={candidateHeadingId}
              className="px-2 py-1 text-xs text-token-description-foreground"
            >
              Select a page
            </h3>
            <div id={candidateListboxId} role="listbox">
              {available.map((candidate, index) => (
                <button
                  key={candidate.pageId}
                  id={`${candidateListboxId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-posinset={index + 1}
                  aria-setsize={activeCandidateCursor ? -1 : available.length}
                  disabled={actionDisabled}
                  onMouseEnter={() => setActiveCandidateIndex(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (actionDisabled) return;
                    selectCandidate(candidate.pageId);
                    if (cardinality === "many") {
                      requestAnimationFrame(() => searchInputRef.current?.focus());
                    }
                  }}
                  className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-token-list-hover-background disabled:opacity-50"
                >
                  <PageIcon className="icon-xs shrink-0 text-token-text-secondary" />
                  <span className="min-w-0 flex-1 truncate text-sm text-token-text-primary">
                    {candidate.title || "Untitled"}
                  </span>
                  <PlusIcon className="icon-2xs shrink-0 text-token-description-foreground" />
                </button>
              ))}
            </div>
            {candidateSearchPending ? (
              <p className="px-2 py-2 text-sm text-token-description-foreground">
                {available.length > 0 ? "Loading more Pages…" : "Loading Pages…"}
              </p>
            ) : null}
            {!candidateSearchPending && available.length === 0 && !candidateError ? (
              <p className="px-2 py-2 text-sm text-token-description-foreground">No pages found</p>
            ) : null}
            {activeCandidateCursor && !candidateError ? (
              <button
                type="button"
                disabled={readOnly || candidateSearchPending}
                onClick={loadMoreCandidates}
                className="flex min-h-7 w-full items-center rounded-lg px-2 text-left text-xs text-token-text-secondary hover:bg-token-list-hover-background disabled:opacity-50"
              >
                {candidateSearchPending ? "Loading…" : "Load more"}
              </button>
            ) : null}
            {candidateError ? (
              <div role="alert" aria-atomic="true">
                <button
                  type="button"
                  aria-label={
                    available.length > 0
                      ? "Couldn’t load more pages. Retry"
                      : "Couldn’t load pages. Retry"
                  }
                  onClick={() => setSearchRetry((current) => current + 1)}
                  className="flex min-h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm text-token-error-foreground hover:bg-token-error-background/20"
                >
                  <span>
                    {available.length > 0 ? "Couldn’t load more pages" : "Couldn’t load pages"}
                  </span>
                  <span className="text-xs font-medium">Retry</span>
                </button>
              </div>
            ) : null}
          </section>
        </div>
        {preview.totalCount > 0 ? (
          <div className="border-t-[0.5px] border-token-border p-1">
            {confirmingClear ? (
              <div className="rounded-lg bg-token-error-background/20 p-2">
                <p className="text-xs text-token-text-secondary">
                  Clear all {preview.totalCount} relations, including unavailable or unloaded pages?
                </p>
                <div className="mt-1 flex justify-end gap-1">
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => setConfirmingClear(false)}
                    className="h-7 rounded-md px-2 text-xs text-token-text-secondary hover:bg-token-foreground/5 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={actionDisabled}
                    onClick={() => {
                      if (actionDisabled) return;
                      onClear();
                      setConfirmingClear(false);
                      closeEditor();
                    }}
                    className="h-7 rounded-md bg-token-error-background/40 px-2 text-xs text-token-error-foreground hover:bg-token-error-background/55 disabled:opacity-50"
                  >
                    Clear all
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={actionDisabled}
                onClick={() => {
                  if (actionDisabled) return;
                  setConfirmingClear(true);
                }}
                className="flex min-h-7 w-full items-center rounded-lg px-2 text-left text-sm text-token-description-foreground hover:bg-token-list-hover-background"
              >
                Clear all…
              </button>
            )}
          </div>
        ) : null}
      </RelationPropertyEditorContentFrame>
    </NodexPopover>
  );
  if (host === "embedded") return editor;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {showLabel ? (
        <span
          className={cn(
            "shrink-0 text-token-description-foreground",
            presentation === "page" ? "text-sm" : "text-[11px]",
          )}
        >
          {label}
        </span>
      ) : null}
      {editor}
    </span>
  );
}
