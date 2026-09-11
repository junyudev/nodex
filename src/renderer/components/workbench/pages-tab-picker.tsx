import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import {
  CanvasIcon,
  DatabaseIcon,
  PageIcon,
  SearchIcon,
  SidePanelPlusIcon,
} from "@/components/shared/icons";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useInfiniteLibraryCatalog } from "@/lib/use-library-navigation";
import { MAX_LIBRARY_QUERY_LENGTH, type LibraryRouteTarget } from "../../../shared/library-module";
import { useLibraryCreateCommands } from "../library/library-new-menu";
import {
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import { cn } from "@/lib/utils";
import {
  configuredPageSearchProjectIds,
  useInteractivePageSearch,
} from "@/lib/interactive-page-search";

function targetIcon(target: LibraryRouteTarget) {
  if (target.kind === "database" || target.kind === "view") {
    return <DatabaseIcon />;
  }
  if (target.kind === "canvas") return <CanvasIcon className="icon-xs" />;
  return <PageIcon />;
}

export interface PagesTabPickerDataSource {
  readonly useCatalog: (
    input: Parameters<typeof useInfiniteLibraryCatalog>[0],
  ) => Pick<
    ReturnType<typeof useInfiniteLibraryCatalog>,
    "data" | "isPending" | "isError" | "hasNextPage" | "refetch" | "fetchNextPage"
  >;
  readonly useCreateCommands: (
    input: Parameters<typeof useLibraryCreateCommands>[0],
  ) => Pick<
    ReturnType<typeof useLibraryCreateCommands>,
    "isPending" | "createPage" | "createDatabase"
  >;
}

const DEFAULT_DATA_SOURCE: PagesTabPickerDataSource = {
  useCatalog: (input) => useInfiniteLibraryCatalog(input),
  useCreateCommands: (input) => useLibraryCreateCommands(input),
};

const pickerRowClassName = cn(
  "flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-hidden",
  "text-token-text-primary hover:bg-token-list-hover-background",
  "focus:bg-token-list-hover-background aria-selected:bg-token-list-hover-background",
);

export function PagesTabPicker({
  onOpenTarget,
  triggerButton,
  dataSource = DEFAULT_DATA_SOURCE,
  defaultOpen = false,
}: {
  readonly onOpenTarget: (target: LibraryRouteTarget, title?: string) => void;
  readonly triggerButton?: ReactElement;
  readonly dataSource?: PagesTabPickerDataSource;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());
  const comboboxId = useId();
  const listboxId = `${comboboxId}-listbox`;
  const liveQuery = query.trim().slice(0, MAX_LIBRARY_QUERY_LENGTH);
  const catalog = dataSource.useCatalog({
    lifecycle: "active",
    kinds: ["page", "database", "canvas"],
    ...(liveQuery ? { query: liveQuery } : {}),
    limit: 40,
  });
  const createCommands = dataSource.useCreateCommands({
    onCreated: (target) => {
      setOpen(false);
      onOpenTarget(target);
    },
  });
  const preview = useInteractivePageSearch({
    projectIds: configuredPageSearchProjectIds(),
    query: liveQuery,
    limit: 40,
  });
  const catalogItems = useMemo(
    () => catalog.data?.pages.flatMap((page) => page.items) ?? [],
    [catalog.data?.pages],
  );
  const items = useMemo(() => {
    if (!liveQuery || dataSource !== DEFAULT_DATA_SOURCE) return catalogItems;
    const previewItems = preview.rows.map((row) => ({
      target: { kind: "page" as const, pageId: row.pageId },
      title: row.title,
      locationLabel: row.locationLabel,
    }));
    const previewPageIds = new Set(preview.rows.map((row) => row.pageId));
    return [
      ...previewItems,
      ...catalogItems.filter(
        (item) => item.target.kind !== "page" || !previewPageIds.has(item.target.pageId),
      ),
    ];
  }, [catalogItems, dataSource, liveQuery, preview.rows]);
  const resolvedActiveIndex = items.length === 0 ? -1 : Math.min(activeIndex, items.length - 1);
  const activeDescendantId =
    resolvedActiveIndex >= 0 ? `${listboxId}-option-${resolvedActiveIndex}` : undefined;
  useEffect(() => {
    if (resolvedActiveIndex < 0) return;
    optionRefs.current.get(resolvedActiveIndex)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [resolvedActiveIndex]);
  const accept = (target: LibraryRouteTarget, title?: string) => {
    setOpen(false);
    onOpenTarget(target, title);
  };
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length === 0) return;
      setActiveIndex((current) => (current + 1) % items.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      setActiveIndex((current) => (current - 1 + items.length) % items.length);
      return;
    }
    if (event.key !== "Enter" || resolvedActiveIndex < 0) return;
    event.preventDefault();
    const item = items[resolvedActiveIndex];
    if (item) accept(item.target, item.title);
  };

  return (
    <NodexPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) return;
        setQuery("");
        setActiveIndex(0);
      }}
    >
      <NodexTooltip tooltipContent="Open Page, Database, or Canvas" side="bottom">
        <NodexPopoverTrigger>
          {triggerButton ?? (
            <button
              type="button"
              className={cn(TOOLBAR_BUTTON_BASE_CLASS, TOOLBAR_BUTTON_GHOST_CLASS)}
              aria-label="Open Page, Database, or Canvas"
            >
              <SidePanelPlusIcon className="icon-xs" />
            </button>
          )}
        </NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent
        role="dialog"
        aria-label="Open Page, Database, or Canvas"
        align="start"
        sideOffset={6}
        className="w-[360px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
        initialFocus={inputRef}
      >
        <div className="flex h-10 items-center gap-2 border-b border-token-border px-3">
          <SearchIcon className="icon-sm shrink-0 text-token-text-tertiary" />
          <input
            ref={inputRef}
            id={comboboxId}
            role="combobox"
            aria-label="Search Pages"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-activedescendant={activeDescendantId}
            maxLength={MAX_LIBRARY_QUERY_LENGTH}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value.slice(0, MAX_LIBRARY_QUERY_LENGTH));
              setActiveIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Open a Page…"
            className="min-w-0 flex-1 bg-transparent text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary"
          />
        </div>
        <div
          id={listboxId}
          role="listbox"
          aria-labelledby={comboboxId}
          aria-busy={catalog.isPending}
          className="max-h-[280px] overflow-y-auto p-1"
        >
          {items.map((item, index) => (
            <button
              key={`${item.target.kind}:${JSON.stringify(item.target)}`}
              id={`${listboxId}-option-${index}`}
              ref={(element) => {
                if (element) optionRefs.current.set(index, element);
                else optionRefs.current.delete(index);
              }}
              type="button"
              role="option"
              aria-selected={index === resolvedActiveIndex}
              className={pickerRowClassName}
              onFocus={() => setActiveIndex(index)}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => accept(item.target, item.title)}
            >
              <span className="shrink-0 text-token-text-secondary">{targetIcon(item.target)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.title.trim() || "Untitled"}</span>
                {item.locationLabel ? (
                  <span className="block truncate text-xs text-token-text-tertiary">
                    {item.locationLabel}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
          {catalog.isPending ? (
            <div role="status" className="px-3 py-6 text-center text-sm text-token-text-tertiary">
              {items.length > 0 ? "Loading more Pages…" : "Loading Pages…"}
            </div>
          ) : null}
          {catalog.isError ? (
            <button
              type="button"
              className="w-full px-3 py-6 text-center text-sm text-token-text-secondary"
              onClick={() => void catalog.refetch()}
            >
              Could not load Pages. Retry
            </button>
          ) : null}
          {!catalog.isPending && !catalog.isError && items.length === 0 ? (
            <div role="status" className="px-3 py-6 text-center text-sm text-token-text-tertiary">
              No Pages found
            </div>
          ) : null}
          {catalog.hasNextPage ? (
            <button
              type="button"
              className="h-7 w-full rounded-lg px-2 text-left text-sm text-token-text-secondary hover:bg-token-list-hover-background"
              onClick={() => void catalog.fetchNextPage()}
            >
              Load more
            </button>
          ) : null}
        </div>
        <div className="border-t border-token-border p-1">
          <button
            type="button"
            className={pickerRowClassName}
            disabled={createCommands.isPending}
            onClick={() => void createCommands.createPage()}
          >
            <PageIcon />
            New Page
          </button>
          <button
            type="button"
            className={pickerRowClassName}
            disabled={createCommands.isPending}
            onClick={() => void createCommands.createDatabase()}
          >
            <DatabaseIcon />
            New Database
          </button>
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}

export function EmptyPagesScene({
  onOpenTarget,
  dataSource,
}: {
  readonly onOpenTarget: (target: LibraryRouteTarget, title?: string) => void;
  readonly dataSource?: PagesTabPickerDataSource;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <PageIcon className="size-7 text-token-text-tertiary" />
        <div>
          <div className="text-sm font-medium text-token-text-primary">Open a Page</div>
          <div className="mt-1 text-sm text-token-text-tertiary">
            Pages, Databases, and Canvases share this tab bar.
          </div>
        </div>
        <PagesTabPicker
          onOpenTarget={onOpenTarget}
          dataSource={dataSource}
          triggerButton={
            <button
              type="button"
              className="h-8 rounded-lg bg-token-foreground px-3 text-sm font-medium text-token-background"
            >
              Browse Pages
            </button>
          }
        />
      </div>
    </div>
  );
}
