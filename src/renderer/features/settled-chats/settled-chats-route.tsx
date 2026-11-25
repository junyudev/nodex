import { defineMessages, useIntl, type IntlShape } from "@/lib/i18n";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { UndoIcon } from "@/components/shared/icons";
import {
  NodexDropdownButtonTrigger,
  NodexOptionPicker,
  type NodexOptionPickerOption,
} from "@/components/ui/dropdown";
import { PageSearchInput } from "@/components/ui/page-search-input";
import { PageEmptyState } from "@/components/ui/section-header";
import { SearchablePageLayout } from "@/components/ui/searchable-page-layout";
import { NodexTooltip } from "@/components/ui/tooltip";
import { presentSessionTitle } from "@/lib/session-title-presentation";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  useWorkbenchLibrarySessionLane,
  type WorkbenchSessionCatalog,
} from "@/lib/use-workbench-session-catalog";
import type { Project, ProjectSession } from "../../../shared/types";
import { groupBySettledDay, type SettledDayBucket } from "./settled-chats-model";
import { buildSettledChatsPath, parseSettledChatsPath } from "./settled-chats-routes";

const ALL_PROJECTS = "";
const SEARCH_DEBOUNCE_MS = 150;

const BUCKET_LABELS = defineMessages({
  today: { id: "settledChats.settledChatsRoute.today", defaultMessage: "Today" },
  yesterday: { id: "settledChats.settledChatsRoute.yesterday", defaultMessage: "Yesterday" },
  week: { id: "settledChats.settledChatsRoute.previous7Days", defaultMessage: "Previous 7 days" },
  month: {
    id: "settledChats.settledChatsRoute.previous30Days",
    defaultMessage: "Previous 30 days",
  },
});

function bucketLabel(bucket: SettledDayBucket, now: number, intl: IntlShape): string {
  switch (bucket.kind) {
    case "today":
      return intl.formatMessage(BUCKET_LABELS.today);
    case "yesterday":
      return intl.formatMessage(BUCKET_LABELS.yesterday);
    case "previous-7-days":
      return intl.formatMessage(BUCKET_LABELS.week);
    case "previous-30-days":
      return intl.formatMessage(BUCKET_LABELS.month);
    case "month": {
      const date = new Date(bucket.year, bucket.month, 1);
      return intl.formatDate(date, {
        month: "long",
        ...(bucket.year === new Date(now).getFullYear() ? {} : { year: "numeric" }),
      });
    }
  }
}

/** Recent rows say when in the day; older ones say which day. */
function settledTimeLabel(
  settledAt: number,
  bucket: SettledDayBucket,
  now: number,
  intl: IntlShape,
): string {
  if (bucket.kind === "today" || bucket.kind === "yesterday")
    return intl.formatTime(settledAt, { hour: "numeric", minute: "2-digit" });
  const sameYear = new Date(settledAt).getFullYear() === new Date(now).getFullYear();
  return intl.formatDate(settledAt, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export interface SettledChatsRouteProps {
  readonly path: string;
  readonly projects: readonly Project[];
  readonly resolveScene: WorkbenchSessionCatalog["resolveScene"];
  readonly onPathChange: (path: string) => void;
  readonly onOpenSession: (session: ProjectSession) => void;
  readonly onReopenSession: (session: ProjectSession) => void | Promise<void>;
  readonly onOpenSessionContextMenu?: (
    session: ProjectSession,
    event: MouseEvent<HTMLElement>,
  ) => void;
}

/**
 * Every chat the reader settled, most recently settled first, grouped by when. Scrolling reads
 * further back until the list ends, and the end says so.
 */
export function SettledChatsRoute({
  path,
  projects,
  resolveScene,
  onPathChange,
  onOpenSession,
  onReopenSession,
  onOpenSessionContextMenu,
}: SettledChatsRouteProps) {
  const intl = useIntl();
  const { projectId: requestedProjectId } = parseSettledChatsPath(path);
  // A filter naming a Project that is gone shows every Project rather than nothing.
  const projectId =
    requestedProjectId !== null && projects.some((project) => project.id === requestedProjectId)
      ? requestedProjectId
      : null;
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const lane = useWorkbenchLibrarySessionLane({
    projectId,
    order: "settlement",
    lifecycle: "settled",
    enabled: true,
    resolveScene,
    query,
  });
  const { collection } = lane;
  const sessions = collection.presentations.map((presentation) => presentation.domain);
  const [now] = useState(() => Date.now());
  const groups = groupBySettledDay(sessions, (session) => session.settledAt, now);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const total = collection.totalCount;

  const sentinelRef = useRef<HTMLDivElement>(null);
  const canReadMore =
    collection.state.kind === "ready" &&
    collection.hasMore &&
    !lane.loadingMore &&
    !lane.loadMoreFailed;
  const readMore = useEffectEvent(() => {
    void lane.loadMore();
  });
  // Reading further back follows the scroll. Each read toggles `canReadMore`, which observes the
  // sentinel afresh, so a window that still leaves it in view reads the next one.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !canReadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) readMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canReadMore]);

  const projectOptions: NodexOptionPickerOption[] = [
    {
      value: ALL_PROJECTS,
      label: intl.formatMessage({
        id: "settledChats.settledChatsRoute.allProjects",
        defaultMessage: "All Projects",
      }),
    },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];

  let content;
  if (collection.state.kind === "error") {
    content = (
      <PageEmptyState
        title={intl.formatMessage({
          id: "settledChats.settledChatsRoute.loadFailed",
          defaultMessage: "Settled chats couldn’t load",
        })}
        description={collection.state.message}
        actions={
          <FooterButton onClick={() => void lane.retry()}>
            {intl.formatMessage({
              id: "settledChats.settledChatsRoute.retry",
              defaultMessage: "Retry",
            })}
          </FooterButton>
        }
      />
    );
  } else if (collection.state.kind !== "ready") {
    content = (
      <ListNote>
        {intl.formatMessage({
          id: "settledChats.settledChatsRoute.loading",
          defaultMessage: "Loading settled chats…",
        })}
      </ListNote>
    );
  } else if (sessions.length === 0 && !collection.hasMore) {
    content = query ? (
      <ListNote>
        {intl.formatMessage(
          {
            id: "settledChats.settledChatsRoute.noMatches",
            defaultMessage: "No settled chats match “{query}”",
          },
          { query },
        )}
      </ListNote>
    ) : (
      <PageEmptyState
        title={intl.formatMessage({
          id: "settledChats.settledChatsRoute.empty",
          defaultMessage: "No settled chats",
        })}
        description={intl.formatMessage({
          id: "settledChats.settledChatsRoute.emptyDescription",
          defaultMessage: "Chats you settle leave your lists and wait here.",
        })}
      />
    );
  } else {
    content = (
      <>
        {groups.map((group) => (
          <section key={group.key} className="flex flex-col">
            <h2 className="px-3 pt-5 pb-1.5 text-xs font-medium text-token-description-foreground">
              {bucketLabel(group.bucket, now, intl)}
            </h2>
            <ul className="flex flex-col">
              {group.items.map((session) => (
                <SettledChatRow
                  key={session.id}
                  session={session}
                  projectName={
                    projectId === null && session.projectId
                      ? (projectNames.get(session.projectId) ?? null)
                      : null
                  }
                  timeLabel={
                    session.settledAt == null
                      ? null
                      : settledTimeLabel(session.settledAt, group.bucket, now, intl)
                  }
                  onOpen={() => onOpenSession(session)}
                  onReopen={() => void onReopenSession(session)}
                  onContextMenu={
                    onOpenSessionContextMenu
                      ? (event) => onOpenSessionContextMenu(session, event)
                      : undefined
                  }
                />
              ))}
            </ul>
          </section>
        ))}
        <div ref={sentinelRef} aria-hidden="true" />
        <ListNote>
          {collection.hasMore ? (
            lane.loadMoreFailed ? (
              <>
                {intl.formatMessage({
                  id: "settledChats.settledChatsRoute.moreFailed",
                  defaultMessage: "Older chats couldn’t load",
                })}
                <FooterButton onClick={() => void lane.loadMore()}>
                  {intl.formatMessage({
                    id: "settledChats.settledChatsRoute.retry",
                    defaultMessage: "Retry",
                  })}
                </FooterButton>
              </>
            ) : (
              intl.formatMessage({
                id: "settledChats.settledChatsRoute.loadingMore",
                defaultMessage: "Loading older chats…",
              })
            )
          ) : query ? (
            intl.formatMessage(
              {
                id: "settledChats.settledChatsRoute.endOfMatches",
                defaultMessage:
                  "{count, plural, one {That’s the one match} other {That’s all # matches}}",
              },
              { count: total ?? sessions.length },
            )
          ) : (
            intl.formatMessage(
              {
                id: "settledChats.settledChatsRoute.endOfList",
                defaultMessage:
                  "{count, plural, one {That’s your one settled chat} other {That’s all # settled chats}}",
              },
              { count: total ?? sessions.length },
            )
          )}
        </ListNote>
      </>
    );
  }

  return (
    <SearchablePageLayout
      title={
        <span className="flex items-baseline gap-2">
          {intl.formatMessage({
            id: "settledChats.settledChatsRoute.title",
            defaultMessage: "Settled",
          })}
          {total === null ? null : (
            <span
              className="text-base font-normal text-token-description-foreground tabular-nums"
              data-settled-chats-total=""
            >
              {intl.formatNumber(total)}
            </span>
          )}
        </span>
      }
      subtitle={intl.formatMessage({
        id: "settledChats.settledChatsRoute.subtitle",
        defaultMessage: "Chats you settled, most recent first. Reopen one to bring it back.",
      })}
      search={
        <PageSearchInput
          id="settled-chats-search"
          label={intl.formatMessage({
            id: "settledChats.settledChatsRoute.search",
            defaultMessage: "Search settled chats",
          })}
          placeholder={intl.formatMessage({
            id: "settledChats.settledChatsRoute.search",
            defaultMessage: "Search settled chats",
          })}
          className="min-w-0 flex-1"
          searchQuery={search}
          onSearchQueryChange={setSearch}
        />
      }
      headerAction={
        projects.length > 0 ? (
          <NodexOptionPicker
            value={projectId ?? ALL_PROJECTS}
            options={projectOptions}
            search={projects.length > 8 ? "filter" : "none"}
            searchPlaceholder={intl.formatMessage({
              id: "settledChats.settledChatsRoute.findProject",
              defaultMessage: "Find a Project",
            })}
            align="end"
            onValueChange={(value) =>
              onPathChange(buildSettledChatsPath(value === ALL_PROJECTS ? null : value))
            }
            triggerButton={
              <NodexDropdownButtonTrigger
                size="rule"
                shape="pill"
                className="max-w-48 ps-3"
                aria-label={intl.formatMessage({
                  id: "settledChats.settledChatsRoute.projectFilter",
                  defaultMessage: "Show chats from",
                })}
              >
                <span className="truncate">
                  {projectId === null
                    ? projectOptions[0]!.label
                    : (projectNames.get(projectId) ?? projectOptions[0]!.label)}
                </span>
              </NodexDropdownButtonTrigger>
            }
          />
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 flex-col pb-(--padding-panel)" data-settled-chats-list="">
        {content}
      </div>
    </SearchablePageLayout>
  );
}

function SettledChatRow({
  session,
  projectName,
  timeLabel,
  onOpen,
  onReopen,
  onContextMenu,
}: {
  readonly session: ProjectSession;
  readonly projectName: string | null;
  readonly timeLabel: string | null;
  readonly onOpen: () => void;
  readonly onReopen: () => void;
  readonly onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const intl = useIntl();
  const title = presentSessionTitle(session, intl);
  const preview = session.thread?.threadPreview.trim() ?? "";
  const reopenLabel = intl.formatMessage({
    id: "settledChats.settledChatsRoute.reopenChat",
    defaultMessage: "Reopen chat",
  });
  return (
    <li className="group/settled-row relative" data-settled-chat-row={session.id}>
      <button
        type="button"
        className="flex w-full cursor-interaction flex-col gap-0.5 rounded-lg px-3 py-2 text-left outline-none hover:bg-token-list-hover-background focus-visible:ring-2 focus-visible:ring-token-focus-border"
        onClick={onOpen}
        onContextMenu={onContextMenu}
      >
        <span className="flex min-w-0 items-baseline gap-3 pe-8">
          <span className="min-w-0 flex-1 truncate text-sm text-token-foreground">{title}</span>
          {timeLabel ? (
            <span className="shrink-0 text-xs text-token-description-foreground tabular-nums group-hover/settled-row:invisible">
              {timeLabel}
            </span>
          ) : null}
        </span>
        {projectName || preview ? (
          <span className="flex min-w-0 items-baseline gap-1.5 pe-8 text-xs text-token-description-foreground">
            {projectName ? (
              <span className="max-w-40 shrink-0 truncate text-(--color-text-secondary)">
                {projectName}
              </span>
            ) : null}
            {projectName && preview ? <span aria-hidden="true">·</span> : null}
            {preview ? <span className="min-w-0 flex-1 truncate">{preview}</span> : null}
          </span>
        ) : null}
      </button>
      <NodexTooltip tooltipContent={reopenLabel} side="left">
        <button
          type="button"
          aria-label={reopenLabel}
          className="absolute end-2 top-1.5 hidden size-7 cursor-interaction items-center justify-center rounded-full text-token-description-foreground group-hover/settled-row:flex hover:bg-token-foreground/5 hover:text-token-foreground"
          data-settled-chat-reopen=""
          onClick={onReopen}
        >
          <UndoIcon className="icon-xs" />
        </button>
      </NodexTooltip>
    </li>
  );
}

function ListNote({ children }: { readonly children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-6 text-xs text-token-description-foreground"
      data-settled-chats-note=""
    >
      {children}
    </div>
  );
}

function FooterButton({
  onClick,
  children,
}: {
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cursor-interaction rounded-full px-2 py-0.5 text-xs text-token-foreground hover:bg-token-foreground/5"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
