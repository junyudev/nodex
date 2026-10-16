import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CanvasIcon,
  ChevronDownIcon,
  DatabaseIcon,
  PageIcon,
  SearchIcon,
} from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { cn } from "@/lib/utils";
import type { LibraryRouteTarget } from "../../../shared/library-module";
import {
  ALL_SPACE_CONTENT_KINDS,
  boundSpaceContentQuery,
  DEFAULT_SPACE_CONTENT_DATA_SOURCE,
  useSpaceContentResults,
  type SpaceContentDataSource,
  type SpaceContentItem,
  type SpaceContentKind,
} from "./space-content";

const SPACE_HOME_TABS = [
  { id: "recent", label: "Recent", kinds: ALL_SPACE_CONTENT_KINDS, empty: "Nothing in Space yet" },
  { id: "pages", label: "Pages", kinds: ["page"], empty: "No pages yet" },
  { id: "databases", label: "Databases", kinds: ["database"], empty: "No databases yet" },
  { id: "canvases", label: "Canvases", kinds: ["canvas"], empty: "No canvases yet" },
] as const satisfies readonly {
  readonly id: string;
  readonly label: string;
  readonly kinds: readonly SpaceContentKind[];
  readonly empty: string;
}[];

type SpaceHomeTabId = (typeof SPACE_HOME_TABS)[number]["id"];

/** Name, Location, and Last edited share one column grid with the header. */
const COLUMN_LOCATION_CLASS = "w-60 shrink-0 truncate @max-[760px]:hidden";
const COLUMN_EDITED_CLASS = "w-28 shrink-0 @max-[520px]:hidden";
const ROW_SEPARATOR_CLASS =
  "after:pointer-events-none after:absolute after:inset-x-3 after:-bottom-px after:h-px after:bg-token-border-light";

function ContentGlyph({ target }: { readonly target: LibraryRouteTarget }) {
  // The Page glyph is drawn inset in its viewBox; a larger box gives it equal optical weight.
  if (target.kind === "page") return <PageIcon className="size-6 text-token-charts-blue" />;
  if (target.kind === "canvas")
    return <CanvasIcon className="icon-base text-token-charts-orange" />;
  return <DatabaseIcon className="icon-base text-token-charts-green" />;
}

function SpaceHomeRow({
  item,
  nowMs,
  onOpen,
}: {
  readonly item: SpaceContentItem;
  readonly nowMs: number;
  readonly onOpen: () => void;
}) {
  return (
    <li className="group/row [&:has(+li:hover)>button]:after:opacity-0">
      <button
        type="button"
        className={cn(
          "relative flex h-[50px] w-full items-center gap-4 rounded-[15px] px-2 text-left outline-none",
          "hover:bg-token-list-hover-background hover:after:opacity-0",
          "focus-visible:bg-token-list-hover-background focus-visible:after:opacity-0",
          ROW_SEPARATOR_CLASS,
        )}
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[12.5px] border border-token-border bg-token-main-surface-primary">
            <ContentGlyph target={item.target} />
          </span>
          <span className="min-w-0 truncate text-[14px] leading-[21px] text-token-foreground">
            {item.title.trim() || "Untitled"}
          </span>
        </span>
        <span className={cn(COLUMN_LOCATION_CLASS, "text-[13px] text-text-secondary-solid")}>
          {item.locationLabel || "—"}
        </span>
        <span className={cn(COLUMN_EDITED_CLASS, "text-[13px] text-text-secondary-solid")}>
          {item.updatedAt ? formatCompactRelativeTime(Date.parse(item.updatedAt), nowMs) : "—"}
        </span>
      </button>
    </li>
  );
}

function SpaceHomeSkeleton() {
  return (
    <ul aria-hidden="true" className="motion-safe:animate-pulse">
      {[64, 48, 56, 40, 52, 44].map((width) => (
        <li key={width} className="flex h-[50px] items-center gap-4 px-2">
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <span className="size-8 shrink-0 rounded-[12.5px] bg-token-foreground/[0.04]" />
            <span
              className="h-3 rounded-full bg-token-foreground/[0.06]"
              style={{ width: `${width}%` }}
            />
          </span>
          <span className={COLUMN_EDITED_CLASS}>
            <span className="block h-3 w-8 rounded-full bg-token-foreground/[0.06]" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function SpaceHomeMessage({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div role="status" className="flex flex-col items-start gap-1 px-2 py-10">
      <p className="text-[14px] font-medium text-token-foreground">{title}</p>
      {children ? (
        <div className="text-[13px] text-token-description-foreground">{children}</div>
      ) : null}
    </div>
  );
}

/**
 * The Space home: what an empty Pages leaf shows. It lists Library content by last edit,
 * filters by kind or query, and creates new Pages and Databases.
 */
export function SpaceHome({
  onOpenTarget,
  dataSource = DEFAULT_SPACE_CONTENT_DATA_SOURCE,
}: {
  readonly onOpenTarget: (target: LibraryRouteTarget, title?: string) => void;
  readonly dataSource?: SpaceContentDataSource;
}) {
  const [query, setQuery] = useState("");
  const [tabId, setTabId] = useState<SpaceHomeTabId>("recent");
  // Edit times are relative to when the home appeared.
  const [nowMs] = useState(() => Date.now());
  const tab = SPACE_HOME_TABS.find((candidate) => candidate.id === tabId) ?? SPACE_HOME_TABS[0];
  const { liveQuery, items, catalog } = useSpaceContentResults({
    query,
    kinds: tab.kinds,
    dataSource,
  });
  const createCommands = dataSource.useCreateCommands({
    onCreated: (target) => onOpenTarget(target),
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const idPrefix = useId();
  const tabDomId = (id: SpaceHomeTabId) => `${idPrefix}-tab-${id}`;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = catalog;

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = moreRef.current;
    if (!root || !sentinel || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { root, rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  let body: ReactNode;
  if (catalog.isError && items.length === 0) {
    body = (
      <SpaceHomeMessage title="Space could not load">
        <button
          type="button"
          className="text-token-foreground underline-offset-2 hover:underline"
          onClick={() => void catalog.refetch()}
        >
          Try again
        </button>
      </SpaceHomeMessage>
    );
  } else if (catalog.isPending && items.length === 0) {
    body = <SpaceHomeSkeleton />;
  } else if (items.length === 0) {
    body = liveQuery ? (
      <SpaceHomeMessage title={`No results for “${liveQuery}”`} />
    ) : (
      <SpaceHomeMessage title={tab.empty}>
        {tab.id === "canvases"
          ? "Add a canvas inside any page."
          : "Use New to create a page or database."}
      </SpaceHomeMessage>
    );
  } else {
    body = (
      <ul aria-label={tab.label}>
        {items.map((item) => (
          <SpaceHomeRow
            key={`${item.target.kind}:${JSON.stringify(item.target)}`}
            item={item}
            nowMs={nowMs}
            onOpen={() => onOpenTarget(item.target, item.title)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="@container h-full min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
    >
      <div className="mx-auto w-full max-w-[1440px] px-12 pt-4 pb-16 @max-[640px]:px-6">
        <header className="flex min-h-15 items-center gap-3 py-3">
          <h1 className="flex min-h-9 min-w-0 flex-1 items-center truncate heading-lg font-medium text-token-foreground">
            Space
          </h1>
          <label
            className={cn(
              "flex h-8 w-60 min-w-0 items-center gap-2 rounded-full border border-token-border-heavy px-3",
              "focus-within:border-token-text-tertiary @max-[520px]:w-auto @max-[520px]:flex-1",
            )}
          >
            <SearchIcon className="icon-sm shrink-0 text-token-description-foreground" />
            <input
              type="text"
              aria-label="Search Space"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(boundSpaceContentQuery(event.target.value))}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !query) return;
                event.preventDefault();
                setQuery("");
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-token-foreground outline-none placeholder:text-token-description-foreground"
            />
          </label>
          <NodexDropdownMenu
            align="end"
            contentWidth="xs"
            triggerButton={
              <button
                type="button"
                disabled={createCommands.isPending}
                className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-token-foreground ps-4 pe-3 text-[13px] font-medium text-token-background disabled:opacity-60"
              >
                New
                <ChevronDownIcon className="size-4 shrink-0" aria-hidden />
              </button>
            }
          >
            <NodexDropdownItem
              leftSlot={<PageIcon className="icon-xs" />}
              onSelect={() => void createCommands.createPage()}
            >
              Page
            </NodexDropdownItem>
            <NodexDropdownItem
              leftSlot={<DatabaseIcon className="icon-xs" />}
              onSelect={() => void createCommands.createDatabase()}
            >
              Database
            </NodexDropdownItem>
          </NodexDropdownMenu>
        </header>

        <div role="tablist" aria-label="Space content" className="mt-2 flex items-center gap-1">
          {SPACE_HOME_TABS.map((candidate) => {
            const selected = candidate.id === tab.id;
            return (
              <button
                key={candidate.id}
                id={tabDomId(candidate.id)}
                type="button"
                role="tab"
                aria-selected={selected}
                className={cn(
                  "h-9 shrink-0 rounded-full px-4 text-[13px] font-medium outline-none",
                  "focus-visible:ring-2 focus-visible:ring-token-focus-border",
                  selected
                    ? "bg-token-foreground/[0.055] text-token-foreground"
                    : "text-text-secondary-solid hover:text-token-foreground",
                )}
                onClick={() => setTabId(candidate.id)}
              >
                {candidate.label}
              </button>
            );
          })}
        </div>

        <section role="tabpanel" aria-labelledby={tabDomId(tab.id)} className="-mx-2 mt-6">
          <div
            aria-hidden="true"
            className={cn(
              "relative flex h-10.5 items-center gap-4 px-2 text-[13px] text-text-secondary-solid",
              ROW_SEPARATOR_CLASS,
            )}
          >
            <span className="min-w-0 flex-1">Name</span>
            <span className={COLUMN_LOCATION_CLASS}>Location</span>
            <span className={COLUMN_EDITED_CLASS}>Last edited</span>
          </div>
          {body}
          {hasNextPage ? (
            <button
              ref={moreRef}
              type="button"
              disabled={isFetchingNextPage}
              className="mt-2 h-8 rounded-full px-3 text-[13px] text-text-secondary-solid hover:text-token-foreground"
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading…" : "Show more"}
            </button>
          ) : null}
        </section>
      </div>
    </div>
  );
}
