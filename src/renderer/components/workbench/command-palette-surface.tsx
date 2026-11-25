import { presentSessionTitle } from "@/lib/session-title-presentation";
import { FormattedMessage, useIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import { SkillCubeIcon } from "@/components/shared/icons/customize-action-icons";
import type { FileSearchScope } from "../../../shared/file-search";
import {
  commandPaletteWorkspaceScope,
  COMMAND_PALETTE_CONTEXT_SELECTION,
  type CommandPaletteWorkspaceSelection,
} from "@/lib/command-palette-workspace-selection";
import { isAbsoluteSearchPath } from "../../../shared/file-search-paths";
import { useCommandPaletteFileSearch } from "@/lib/use-command-palette-file-search";
import { describeFileSearchIncomplete } from "@/lib/file-search-status";
import { useWorkspaceTextSearch } from "@/lib/use-workspace-text-search";
import {
  useWorkspaceTextSearchHistory,
  workspaceTextSearchHistoryScope,
} from "@/lib/workspace-text-search-history";
import { getWorkspaceSearchPriorityFolders } from "@/lib/workspace-search-recent-files";
import {
  CommandPaletteTextToolbar,
  CommandPaletteTextHistoryRecorder,
  CommandPaletteTextRow,
  CommandPaletteTextHistoryRow,
  CommandPaletteTextStatus,
  CommandPaletteTextError,
  workspaceTextSearchResultLabels,
} from "./command-palette-text-search";
import { CommandPaletteWorkspaceToolbar } from "./command-palette-workspace-toolbar";
import {
  CommandPalettePlaceMenu,
  CommandPaletteScopeBar,
  isSearchOptionsFocusKey,
} from "./command-palette-scope-bar";
import { useCommandPaletteTheme, CommandPaletteThemeRow } from "./command-palette-theme";
import {
  useCallback,
  useEffect,
  forwardRef,
  Fragment,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ActivitySpinnerIcon,
  BackIcon,
  ClockIcon,
  InboxIcon,
  NewPageIcon,
  PageIcon,
  FileIcon,
  FolderIcon,
  BoardIcon,
  AerialViewIcon,
  SidePanelSideChatIcon,
  SidebarVisibleIcon,
} from "@/components/shared/icons";
import { hasOpenNodexFloatingEscapeLayer } from "@/components/ui/floating-surface";
import {
  getCommandPaletteScopes,
  cycleCommandPaletteMode,
  type CommandMenuMode,
  type CommandPalettePage,
  type CommandPaletteCommand,
  type CommandPaletteChat,
  type CommandPaletteFile,
  type CommandPaletteText,
} from "../../lib/command-palette";
import {
  buildCommandPaletteCharacterHighlightSegments,
  buildCommandPaletteRangeHighlightSegments,
  limitCommandPaletteHighlightSegments,
  type CommandPaletteHighlightSegment,
} from "../../lib/command-palette-highlight";
import { chatFieldHighlightSegments, chatHighlightSegments } from "../../lib/chat-search";
import {
  buildCommandPalettePageSearchScopeKey,
  getCommandPalettePageSearchPlan,
  normalizeCommandPaletteSearchText,
  type CommandPalettePageSearchBatch,
} from "../../lib/command-palette-page-results";
import { resolveQueryFreshAccept } from "../../lib/query-fresh-picker";
import { cn } from "../../lib/utils";
import { NativeMenuIcon } from "@/components/shared/icons/native-menu-icon";
import { CommandMenuReferenceIcon } from "./command-menu-reference-icons";
import { useFind } from "@/lib/find";
import { usePageMetadataPreview } from "@/lib/interactive-page-search";
import type { FindKind } from "../../../shared/find";
import { ThreadsIcon } from "./threads-icon";
import { WorkbenchSpaceIcon } from "@/components/shared/icons/workbench-navigation-icons";
import { isSpaceSwitchCommandId } from "@/features/spaces/space-switching";
import { NodexTabsRoot, NodexTabsPanel } from "@/components/ui/tabs";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import {
  RENAME_THREAD_COMMAND_ID,
  TOGGLE_SIDEBAR_COMMAND_ID,
} from "../../../shared/window-navigation";
import {
  isSnoozeThreadCommandId,
  OPEN_DB_VIEW_TAB_COMMAND_ID,
} from "@/lib/command-palette-commands";
import type { Project } from "@/lib/types";
import {
  buildCommandPaletteSectionsModel,
  FILE_SEARCH_RETRY_ID,
  DEFAULT_DISCOVERY_LIMITS,
  getCommandPaletteChatLimit,
  getDiscoveryResultLimit,
  type CommandPaletteChatStatus,
  type DiscoveryLimits,
  type ExecutablePaletteItem,
  type PaletteItem,
} from "@/lib/command-palette-sections";

interface CommandPaletteSurfaceProps {
  fileSearchScope?: FileSearchScope | null;
  workspaceSelection?: CommandPaletteWorkspaceSelection;
  onWorkspaceSelectionChange?: (selection: CommandPaletteWorkspaceSelection) => void;
  priorityFolders?: readonly string[];
  open: boolean;
  openTriggerTick: number;
  mode: CommandMenuMode;
  initialQuery?: string;
  onQueryChange?: (query: string) => void;
  commands: readonly CommandPaletteCommand[];
  pages?: readonly CommandPalettePage[];
  projects?: readonly Project[];
  activeProjectId?: string | null;
  recentPageIds?: readonly string[];
  pageSearchBatch?: CommandPalettePageSearchBatch;
  onChangeMode: (mode: CommandMenuMode) => void;
  onRequestClose: () => void;
  /** Runs a chosen result with the query that found it. */
  onExecute: (item: ExecutablePaletteItem, query: string) => void;
}

export interface CommandPaletteSurfaceHandle {
  /** A composing input retains Escape until its composition has finished. */
  isComposing: () => boolean;
  dismissNested: () => boolean;
}

const EMPTY_PALETTE_PAGES: readonly CommandPalettePage[] = [];
const EMPTY_PALETTE_PROJECTS: readonly Project[] = [];
const EMPTY_RECENT_PAGE_IDS: readonly string[] = [];

function getPaletteItemDomId(listId: string, index: number): string {
  return `${listId}-item-${index}`;
}

function isPaletteItemDisabled(item: PaletteItem | undefined): boolean {
  return (item?.kind === "command" || item?.kind === "text") && item.disabled === true;
}

function formatPaletteSectionLabel(intl: IntlShape, section: string) {
  if (section === "Top result")
    return intl.formatMessage({
      id: "workbench.commandPaletteSurface.topResult",
      defaultMessage: "Top result",
    });
  if (section === "Color themes")
    return intl.formatMessage({
      id: "workbench.commandPaletteSurface.colorThemes",
      defaultMessage: "Color themes",
    });
  return intl.formatMessage(
    {
      id: "workbench.commandPaletteSurface.sectionLabel",
      defaultMessage:
        "{section, select, All {All} Actions {Actions} Chat {Chat} Chats {Chats} Pages {Pages} Files {Files} Text {Text} Suggested {Suggested} Navigation {Navigation} Panels {Panels} Project {Project} Configure {Configure} Settings {Settings} Skills {Skills} App {App} other {{section}}}",
    },
    { section },
  );
}

function getModePlaceholder(intl: IntlShape, mode: CommandMenuMode): string {
  if (mode === "actions")
    return intl.formatMessage({
      id: "workbench.commandPaletteSurface.searchActions",
      defaultMessage: "Search actions",
    });
  if (mode === "chats")
    return intl.formatMessage({
      id: "workbench.commandPaletteSurface.searchChats",
      defaultMessage: "Search chats",
    });
  if (mode === "pages")
    return intl.formatMessage({
      id: "workbench.commandPaletteSurface.searchPages",
      defaultMessage: "Search pages",
    });
  if (mode === "files")
    return intl.formatMessage({
      id: "workbench.commandPaletteSurface.searchFiles",
      defaultMessage: "Search files",
    });
  if (mode === "text")
    return intl.formatMessage({
      id: "workbench.commandPaletteSurface.searchFiles",
      defaultMessage: "Search files",
    });
  return intl.formatMessage({
    id: "workbench.commandPaletteSurface.searchNodex",
    defaultMessage: "Search Nodex",
  });
}

function getEmptyMessage(intl: IntlShape, mode: CommandMenuMode, query: string): string {
  if (mode === "chats") {
    return query.length > 0
      ? intl.formatMessage({
          id: "workbench.commandPaletteSurface.noMatchingChats",
          defaultMessage: "No matching chats.",
        })
      : intl.formatMessage({
          id: "workbench.commandPaletteSurface.noChats",
          defaultMessage: "No chats.",
        });
  }
  if (mode === "pages")
    return query.length > 0
      ? intl.formatMessage({
          id: "workbench.commandPaletteSurface.noMatchingPages",
          defaultMessage: "No matching pages.",
        })
      : intl.formatMessage({
          id: "workbench.commandPaletteSurface.noPages",
          defaultMessage: "No pages.",
        });
  if (mode === "files")
    return query
      ? intl.formatMessage({
          id: "workbench.commandPaletteSurface.noMatchingFiles",
          defaultMessage: "No matching files",
        })
      : intl.formatMessage({
          id: "workbench.commandPaletteSurface.typeToSearchFiles",
          defaultMessage: "Type to search files",
        });
  return intl.formatMessage({
    id: "workbench.commandPaletteSurface.noMatchingResults",
    defaultMessage: "No matching results.",
  });
}

function resolveSelectableIndex(
  items: readonly PaletteItem[],
  preferredIndex: number,
  direction: -1 | 1,
): number {
  if (items.length === 0) return -1;

  const startIndex = Math.max(0, Math.min(preferredIndex, items.length - 1));
  for (
    let nextIndex = startIndex;
    nextIndex >= 0 && nextIndex < items.length;
    nextIndex += direction
  ) {
    if (!isPaletteItemDisabled(items[nextIndex])) {
      return nextIndex;
    }
  }

  return -1;
}

function CommandGlyph({ id, className }: { id: string; className: string }) {
  if (id.startsWith("skill:")) return <SkillCubeIcon className={className} />;
  if (id === "captureToInbox") return <InboxIcon className={className} />;
  if (isSpaceSwitchCommandId(id)) return <WorkbenchSpaceIcon className={className} />;
  if (id === "newPage") return <NewPageIcon className={className} />;
  if (id === TOGGLE_SIDEBAR_COMMAND_ID) return <SidebarVisibleIcon className={className} />;
  if (id === "wakeThread" || isSnoozeThreadCommandId(id))
    return <ClockIcon className={className} />;
  if (id === OPEN_DB_VIEW_TAB_COMMAND_ID) return <BoardIcon className={className} />;
  if (id === "openAgentsTab") return <AerialViewIcon className={className} />;
  if (id === "openSideChat") return <SidePanelSideChatIcon className={className} />;
  if (id === "toggleThreadUnread") return <NativeMenuIcon iconKey="unread" className={className} />;
  if (id === "settleThread") return <NativeMenuIcon iconKey="markRead" className={className} />;
  const name =
    id === "newThread" || id === "newThreadInProject" || id === RENAME_THREAD_COMMAND_ID
      ? "compose"
      : id === "archiveThread"
        ? "archive"
        : id === "toggleThreadPin"
          ? "pin"
          : id === "toggleFileTreePanel" || id === "openFolder" || id === "searchFiles"
            ? "folder"
            : id === "openBrowserTab"
              ? "globe"
              : id === "toggleTerminal"
                ? "terminal"
                : id === "settings" ||
                    id === "showKeyboardShortcuts" ||
                    id.endsWith("Settings") ||
                    id.startsWith("settings:")
                  ? "settings"
                  : "search";
  return <CommandMenuReferenceIcon name={name} className={className} />;
}

function CommandRow({ item, selected }: { item: CommandPaletteCommand; selected: boolean }) {
  const subtitle = item.disabledReason ?? item.subtitle;
  const displaySubtitle = Boolean(item.disabledReason || item.id.startsWith("skill:"));

  return (
    <div className={cn("flex w-full gap-2", displaySubtitle ? "items-start" : "items-center")}>
      <CommandGlyph
        id={item.id}
        className={cn(
          "size-4 shrink-0 text-token-description-foreground",
          selected && "text-token-foreground",
          displaySubtitle && "mt-0.5",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="min-w-0 truncate text-token-foreground">
            {item.searchTitleSegments
              ? renderSegments(item.searchTitleSegments, `${item.id}:title`)
              : item.title}
          </div>
        </div>
        {displaySubtitle ? (
          <div className="mt-0.5 truncate text-xs text-token-description-foreground">
            {subtitle}
          </div>
        ) : null}
      </div>
      {item.shortcut ? (
        <ShortcutKeycaps
          keys={[item.shortcut]}
          density="compact"
          className="h-4 min-w-0 rounded-full px-1.5 font-normal tracking-normal"
        />
      ) : null}
    </div>
  );
}

function renderSegments(segments: Array<CommandPaletteHighlightSegment>, keyPrefix: string) {
  return segments.map((segment, index) => (
    <span
      key={`${keyPrefix}:${index}`}
      // Matches gain weight and full contrast; everything else keeps its line's own colour.
      className={segment.highlight ? "font-medium text-token-foreground" : undefined}
    >
      {segment.text}
    </span>
  ));
}

/** A one-line leading glyph slot, aligned with the title line when evidence wraps below. */
function RowGlyph({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "flex h-lh w-4 shrink-0 items-center justify-center text-token-description-foreground",
        selected && "text-token-foreground",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Trailing details on the title line: an Archived marker and the result's Project in a fixed
 * column, so locations line up across Pages and chats.
 */
function RowTrailing({ archived, location }: { archived: boolean; location: ReactNode }) {
  if (!archived && !location) return null;
  return (
    // The box takes the title's line height so smaller labels centre on the title line.
    <span className="ms-auto flex h-lh shrink-0 items-center gap-2 text-token-description-foreground">
      {archived ? (
        <span className="text-xs">
          <FormattedMessage
            id="workbench.commandPaletteSurface.archived"
            defaultMessage="Archived"
          />
        </span>
      ) : null}
      {location ? <span className="w-24 truncate text-end text-sm">{location}</span> : null}
    </span>
  );
}

/** Why a result matched, under its title: one line in All, two in a focused scope. */
function RowEvidence({ compact, children }: { compact: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "pt-0.5 text-xs/relaxed wrap-break-word text-token-description-foreground",
        compact ? "line-clamp-1" : "line-clamp-2",
      )}
    >
      {children}
    </div>
  );
}

function PageRow({
  compact,
  item,
  selected,
}: {
  compact: boolean;
  item: CommandPalettePage;
  selected: boolean;
}) {
  const intl = useIntl();
  const decorations = item.searchDecorations;
  const badges = compact ? [] : (decorations?.badges ?? []);
  return (
    <div className="flex w-full min-w-0 items-start gap-2">
      <RowGlyph selected={selected}>
        <PageIcon className="size-4" />
      </RowGlyph>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2 text-token-foreground">
          {item.page.pageKey ? (
            <span className="shrink-0 text-xs font-medium tabular-nums text-token-description-foreground">
              {decorations?.pageKeySegments
                ? renderSegments(decorations.pageKeySegments, `${item.id}:page-key`)
                : item.page.pageKey}
            </span>
          ) : null}
          <span className="min-w-0 truncate">
            {decorations?.titleSegments
              ? renderSegments(decorations.titleSegments, `${item.id}:title`)
              : item.page.title ||
                intl.formatMessage({
                  id: "workbench.commandPaletteSurface.untitled",
                  defaultMessage: "Untitled",
                })}
          </span>
          {item.pageKeyMatch && !item.pageKeyMatch.isCurrent ? (
            <span className="shrink-0 text-[11px] tabular-nums text-token-description-foreground">
              <FormattedMessage
                id="workbench.commandPaletteSurface.matched"
                defaultMessage={"Matched"}
              />{" "}
              {item.pageKeyMatch.matchedPageKey}
            </span>
          ) : null}
        </div>
        {badges.length > 0 || item.searchPreview ? (
          <RowEvidence compact={compact}>
            {badges.map((badge) => (
              <span
                key={`${item.id}:badge:${badge.id}`}
                className="me-1.5 inline-flex items-center gap-1 rounded-md bg-token-foreground/5 px-1.5 py-px text-[11px] leading-4"
              >
                <span className="text-token-description-foreground/80">{badge.label}</span>
                <span className={badge.tone === "monospace" ? "font-mono" : undefined}>
                  {renderSegments(badge.segments, `${item.id}:badge:${badge.id}`)}
                </span>
              </span>
            ))}
            {item.searchPreview
              ? renderSegments(item.searchPreview.segments, `${item.id}:preview`)
              : null}
          </RowEvidence>
        ) : null}
      </div>
      <RowTrailing archived={item.archived === true} location={item.location} />
    </div>
  );
}

function ChatRow({
  item,
  selected,
  compact,
}: {
  item: CommandPaletteChat;
  selected: boolean;
  compact: boolean;
}) {
  const intl = useIntl();
  const { chat, hint, excerpt } = item;
  const title = presentSessionTitle(chat.title, intl);
  const titleSegments = chatHighlightSegments(title, title === chat.title ? item.titleRanges : []);
  const projectSegments = chatFieldHighlightSegments(chat.projectName, hint, "Project");
  // A message excerpt, branch, pull request or reference explains the match under the title.
  const detail = excerpt
    ? {
        label:
          excerpt.role === "assistant"
            ? intl.formatMessage({
                id: "workbench.commandPaletteSurface.agent",
                defaultMessage: "Agent",
              })
            : excerpt.role === "user"
              ? intl.formatMessage({
                  id: "workbench.commandPaletteSurface.you",
                  defaultMessage: "You",
                })
              : null,
        text: excerpt.text,
        ranges: excerpt.ranges,
      }
    : hint && hint.label !== "Project" && hint.ranges.length > 0
      ? { label: hint.label, text: hint.text, ranges: hint.ranges }
      : null;

  return (
    <div className="flex w-full min-w-0 items-start gap-2">
      <RowGlyph selected={selected}>
        <ThreadsIcon className="size-4" />
      </RowGlyph>
      <div className="min-w-0 flex-1">
        <div className="truncate text-token-foreground">
          {titleSegments ? renderSegments(titleSegments, `${item.id}:title`) : title}
        </div>
        {detail ? (
          <RowEvidence compact={compact}>
            {detail.label ? <span>{detail.label}: </span> : null}
            {renderSegments(
              chatHighlightSegments(detail.text, detail.ranges) ?? [
                { text: detail.text, highlight: false },
              ],
              `${item.id}:detail`,
            )}
          </RowEvidence>
        ) : null}
      </div>
      <RowTrailing
        archived={chat.archived === true}
        location={
          projectSegments ? renderSegments(projectSegments, `${item.id}:project`) : chat.projectName
        }
      />
    </div>
  );
}

const FILE_ROW_TEXT_LIMIT = 100;

function FileRow({ item, query }: { item: CommandPaletteFile; query: string }) {
  const explicitPath = isAbsoluteSearchPath(query.trim()) || /^~[\\/]/u.test(query.trim());
  const matched = explicitPath ? undefined : item.file.matched;
  const segments = limitCommandPaletteHighlightSegments(
    matched
      ? buildCommandPaletteRangeHighlightSegments(item.file.label, matched.label)
      : buildCommandPaletteCharacterHighlightSegments(item.file.label, query, "fuzzy"),
    FILE_ROW_TEXT_LIMIT,
  );
  const description = explicitPath ? item.file.fsPath : item.file.directoryPath;
  const descriptionSegments = limitCommandPaletteHighlightSegments(
    buildCommandPaletteRangeHighlightSegments(description, matched?.directory ?? []),
    FILE_ROW_TEXT_LIMIT,
  );
  const hasMatch = segments.some((segment) => segment.highlight);
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      {item.file.kind === "directory" ? (
        <FolderIcon className="size-4 shrink-0" />
      ) : (
        <FileIcon className="size-4 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex w-full min-w-0 items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1",
              description ? "max-w-[60%] flex-none" : "min-w-0 flex-1",
            )}
          >
            <span className="min-w-0 truncate">
              {segments.map((segment, index) => (
                <span
                  key={index}
                  className={hasMatch && !segment.highlight ? "text-tertiary" : undefined}
                >
                  {segment.text}
                </span>
              ))}
            </span>
          </div>
          {description ? (
            <span className="min-w-0 flex-1 truncate text-sm text-tertiary">
              {descriptionSegments.some((segment) => segment.highlight)
                ? descriptionSegments.map((segment, index) => (
                    <span
                      key={index}
                      className={segment.highlight ? "text-token-text-secondary" : undefined}
                    >
                      {segment.text}
                    </span>
                  ))
                : descriptionSegments.map((segment) => segment.text).join("")}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PaletteSection({
  compact,
  title,
  items,
  listId,
  selectedIndex,
  startIndex,
  onSelectIndex,
  onExecute,
  textLabels,
  showHeading,
  query,
}: {
  /** All lists more kinds at once, so its rows keep their evidence to one line. */
  compact: boolean;
  title: string;
  items: PaletteItem[];
  listId: string;
  selectedIndex: number;
  startIndex: number;
  onSelectIndex: (index: number) => void;
  onExecute: (item: PaletteItem) => void;
  textLabels: ReadonlyMap<string, string>;
  showHeading: boolean;
  query: string;
}) {
  const intl = useIntl();
  if (items.length === 0) return null;
  const label = formatPaletteSectionLabel(intl, title);

  return (
    <section
      cmdk-group=""
      role="presentation"
      className="flex flex-col gap-[var(--spacing)]"
      data-value={title}
    >
      {showHeading ? (
        <div cmdk-group-heading="" aria-hidden="true">
          <span className="block px-[11px] pt-2 text-sm text-token-description-foreground">
            {label}
          </span>
        </div>
      ) : null}
      <div cmdk-group-items="" role="group" aria-label={label}>
        {items.map((item, offset) => {
          const index = startIndex + offset;
          const selected = index === selectedIndex;
          return (
            <button
              id={getPaletteItemDomId(listId, index)}
              key={item.id}
              type="button"
              role="option"
              tabIndex={-1}
              cmdk-item=""
              data-palette-index={index}
              data-selected={selected}
              aria-selected={selected}
              aria-disabled={isPaletteItemDisabled(item) ? "true" : undefined}
              aria-label={
                item.kind === "text" ? `${item.match.path}:${item.match.line}` : undefined
              }
              aria-description={
                item.kind === "text"
                  ? item.match.preview
                  : item.kind === "command" && item.themeAction && item.active
                    ? intl.formatMessage({
                        id: "workbench.commandPaletteSurface.currentTheme",
                        defaultMessage: "Current theme",
                      })
                    : undefined
              }
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => onSelectIndex(index)}
              onClick={() => onExecute(item)}
              disabled={isPaletteItemDisabled(item)}
              className={cn(
                "flex min-h-[calc(var(--spacing)*6)] w-full cursor-interaction rounded-lg px-[calc(var(--padding-row-x)+var(--spacing)*0.5)] py-[calc(var(--padding-row-y)+var(--spacing)*0.5)] text-left text-base text-token-foreground opacity-75 outline-none",
                isPaletteItemDisabled(item)
                  ? "cursor-not-allowed opacity-40 hover:bg-transparent hover:opacity-40"
                  : selected
                    ? "bg-background-primary-ghost-hover opacity-100"
                    : "hover:bg-background-primary-ghost-hover/25 hover:opacity-100",
              )}
            >
              {item.kind === "more" ? (
                <span className="pl-6 text-token-description-foreground">
                  <FormattedMessage
                    id="workbench.commandPaletteSurface.showMore"
                    defaultMessage={"Show more"}
                  />
                </span>
              ) : item.kind === "text" ? (
                <CommandPaletteTextRow
                  match={item.match}
                  pathLabel={textLabels.get(item.match.path)}
                />
              ) : item.kind === "text-query" ? (
                <CommandPaletteTextHistoryRow query={item.query} />
              ) : item.kind === "command" ? (
                item.themeAction ? (
                  <CommandPaletteThemeRow item={item} />
                ) : (
                  <CommandRow item={item} selected={selected} />
                )
              ) : item.kind === "page" ? (
                <PageRow compact={compact} item={item} selected={selected} />
              ) : item.kind === "file" ? (
                <FileRow item={item} query={query} />
              ) : (
                <ChatRow item={item} selected={selected} compact={compact} />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Shown under Pages or chats when search returned its best matches but not all of them. */
const MORE_MATCHES_LABEL = {
  id: "workbench.commandPaletteSurface.moreMatches",
  defaultMessage: "More matches exist. Keep typing to narrow them.",
} satisfies MessageDescriptor;

/** Lasting chat-search states; a search in progress shows the corner spinner instead. */
const CHAT_STATUS_LABELS = {
  incomplete: {
    id: "workbench.commandPaletteSurface.incompleteChatHistory",
    defaultMessage: "Some chat history couldn’t be searched",
  },
  failed: {
    id: "workbench.commandPaletteSurface.chatSearchFailed",
    defaultMessage: "Chats couldn’t be searched",
  },
} satisfies Record<Exclude<CommandPaletteChatStatus, "searching">, MessageDescriptor>;

function SearchStatusRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-h-[calc(var(--spacing)*8)] items-center px-[calc(var(--spacing)*2.5)] py-[calc(var(--spacing)*1.5)] text-sm text-token-description-foreground"
      role="status"
    >
      {children}
    </div>
  );
}

export const CommandPaletteSurface = forwardRef<
  CommandPaletteSurfaceHandle,
  CommandPaletteSurfaceProps
>(function CommandPaletteSurface(
  {
    open,
    openTriggerTick,
    fileSearchScope = null,
    workspaceSelection = COMMAND_PALETTE_CONTEXT_SELECTION,
    onWorkspaceSelectionChange,
    priorityFolders,
    mode,
    initialQuery,
    onQueryChange,
    commands,
    pages = EMPTY_PALETTE_PAGES,
    projects = EMPTY_PALETTE_PROJECTS,
    activeProjectId = null,
    recentPageIds = EMPTY_RECENT_PAGE_IDS,
    pageSearchBatch: injectedPageSearchBatch,
    onChangeMode,
    onRequestClose,
    onExecute,
  },
  forwardedRef,
) {
  const intl = useIntl();
  const theme = useCommandPaletteTheme();
  const [pageStack, setPageStack] = useState<readonly "themes"[]>([]);
  const activePage = pageStack.at(-1);
  const currentCommands = activePage ? theme.pageCommands : commands;
  const currentMode = activePage ? "actions" : mode;
  const inputId = useId();
  const labelId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const scopeControlsRef = useRef<HTMLDivElement>(null);
  const searchOptionsRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);
  const pointerSelectionRef = useRef(false);
  const scopes = getCommandPaletteScopes();
  const workspaceScope = commandPaletteWorkspaceScope(workspaceSelection, fileSearchScope);
  const searchScope = mode === "root" ? fileSearchScope : workspaceScope;
  const historyScope = workspaceTextSearchHistoryScope(fileSearchScope, searchScope);
  const history = useWorkspaceTextSearchHistory({
    hostId: historyScope?.hostId ?? "local",
    projectRoots: historyScope?.roots ?? [],
  });
  const [query, setQuery] = useState(open ? (initialQuery ?? "") : "");
  useEffect(() => {
    if (open && !activePage && (mode === "root" || mode === "files")) onQueryChange?.(query);
  }, [open, query, mode, activePage, onQueryChange]);
  const selectionScopeKey = JSON.stringify([
    mode,
    activePage,
    searchScope?.hostId,
    searchScope?.roots,
  ]);
  const discoveryKey = `${openTriggerTick}:${selectionScopeKey}:${normalizeCommandPaletteSearchText(query)}`;
  const [expandedDiscovery, setExpandedDiscovery] = useState<{
    key: string;
    limits: DiscoveryLimits;
  } | null>(null);
  const discoveryLimits =
    expandedDiscovery?.key === discoveryKey ? expandedDiscovery.limits : DEFAULT_DISCOVERY_LIMITS;
  const hasFileScope = Boolean(searchScope?.roots.length);
  const fileSearch = useCommandPaletteFileSearch({
    showRecent: mode === "files",
    restrictToRoots: mode !== "root" && workspaceSelection.kind === "directory",
    enabled:
      open &&
      hasFileScope &&
      !activePage &&
      (mode === "files" || (mode === "root" && query.trim().length > 0)),
    query,
    scope: searchScope,
  });
  const fileSearchRetry = fileSearch.retry;
  const files: CommandPaletteFile[] = fileSearch.matches.map((file) => ({
    kind: "file",
    id: file.fsPath,
    file,
    hostId: searchScope?.hostId ?? "local",
  }));
  const textSearch = useWorkspaceTextSearch({
    enabled:
      open && !activePage && (mode === "text" || (mode === "root" && query.trim().length > 0)),
    scope: searchScope,
    query,
    fileMask: mode === "text" ? history.fileMask : "",
    priorityFolders:
      priorityFolders ?? getWorkspaceSearchPriorityFolders(searchScope?.hostId ?? "local"),
  });
  const textMatches: CommandPaletteText[] = textSearch.matches.map((match) => ({
    kind: "text",
    id: `text:${match.path}:${match.line}`,
    match,
    hostId: searchScope?.hostId ?? "local",
    disabled: !textSearch.matchesCurrent,
  }));
  const textLabels = workspaceTextSearchResultLabels(textSearch.matches, searchScope?.roots ?? []);
  const [placeProjectId, setPlaceProjectId] = useState<string | null>(null);

  useImperativeHandle(
    forwardedRef,
    () => ({
      isComposing: () => composingRef.current,
      dismissNested: () => {
        if (pageStack.length === 0) return false;
        setPageStack((pages) => pages.slice(0, -1));
        setQuery("");
        inputRef.current?.focus();
        return true;
      },
    }),
    [pageStack],
  );

  const chatLimit = getCommandPaletteChatLimit(currentMode, query, discoveryLimits);
  const pageSearchPlan = getCommandPalettePageSearchPlan(currentMode, query);
  const selectedProject = projects.find((project) => project.id === placeProjectId);
  const kinds: FindKind[] = [];
  if (pageSearchPlan && !injectedPageSearchBatch) kinds.push("page");
  if (chatLimit !== null) kinds.push("chat");
  const find = useFind(
    {
      query,
      kinds,
      place: selectedProject
        ? { kind: "project", projectId: selectedProject.id }
        : { kind: "everywhere" },
      limit: kinds.length > 1 ? 160 : (pageSearchPlan?.searchLimit ?? chatLimit ?? 1),
      preferredProjectId: activeProjectId ?? undefined,
      recentPageIds,
    },
    { enabled: open && kinds.length > 0, refreshKey: openTriggerTick },
  );
  const pageSearchScopeKey = buildCommandPalettePageSearchScopeKey(
    selectedProject ? [selectedProject.id] : undefined,
  );
  const pageSource = find.response?.coverage.find((source) => source.source === "pages");
  const usePreview = !find.response || pageSource?.state === "unavailable";
  const pagePreview = usePageMetadataPreview({
    enabled: open && Boolean(pageSearchPlan) && !injectedPageSearchBatch && usePreview,
    query,
    projectFilterIds: selectedProject ? [selectedProject.id] : undefined,
    preferredProjectId: activeProjectId,
    recentPageIds,
    limit: pageSearchPlan?.searchLimit,
  });
  const pageSearchBatch = useMemo<CommandPalettePageSearchBatch>(
    () =>
      injectedPageSearchBatch ?? {
        query: query.trim(),
        scopeKey: pageSearchScopeKey,
        results: usePreview
          ? pagePreview
          : (find.response?.hits ?? []).flatMap((hit) => (hit.kind === "page" ? [hit.page] : [])),
        status: find.pending
          ? "pending"
          : find.failed || pageSource?.state === "unavailable"
            ? "error"
            : "success",
        error: null,
        coverage: pageSource?.state === "indexing" ? "indexing" : undefined,
        truncated: pageSource?.truncated,
      },
    [
      injectedPageSearchBatch,
      query,
      pageSearchScopeKey,
      usePreview,
      pagePreview,
      find.response,
      find.pending,
      find.failed,
      pageSource,
    ],
  );
  const visibleModel = useMemo(
    () =>
      buildCommandPaletteSectionsModel({
        query,
        mode: currentMode,
        commands: currentCommands,
        projects,
        activeProjectId,
        pages,
        findResponse: find.response,
        findPending: find.pending,
        findFailed: find.failed,
        files,
        fileSearchRetry: fileSearchRetry?.target ?? null,
        textMatches,
        textQueries: history.queries,
        discoveryLimits,
        pageSearchBatch: pageSearchBatch,
        pageSearchScopeKey,
      }),
    [
      pageSearchScopeKey,
      activeProjectId,
      pages,
      currentCommands,
      currentMode,
      query,
      pageSearchBatch,
      projects,
      find.response,
      find.pending,
      find.failed,
      files,
      fileSearchRetry?.target,
      textMatches,
      history.queries,
      discoveryLimits,
    ],
  );
  const { sections, flatItems } = visibleModel;
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [openingInput, setOpeningInput] = useState({ open, initialQuery, openTriggerTick });
  if (
    openingInput.open !== open ||
    openingInput.initialQuery !== initialQuery ||
    openingInput.openTriggerTick !== openTriggerTick
  ) {
    setOpeningInput({ open, initialQuery, openTriggerTick });
    if (open) {
      setQuery(initialQuery ?? "");
      setPlaceProjectId(null);
      setPageStack([]);
    } else {
      setQuery("");
      setSelectedIndex(0);
    }
  }
  const selectionKey = JSON.stringify([
    selectionScopeKey,
    open,
    openTriggerTick,
    visibleModel.query,
    placeProjectId,
  ]);
  const [previousSelectionKey, setPreviousSelectionKey] = useState(selectionKey);
  const resetSelection = previousSelectionKey !== selectionKey && open;
  if (previousSelectionKey !== selectionKey) setPreviousSelectionKey(selectionKey);

  useEffect(() => {
    if (!openingInput.open) return;
    const rafId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [openingInput]);

  const scrolledSelectionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      scrolledSelectionKeyRef.current = null;
      return;
    }
    if (scrolledSelectionKeyRef.current === selectionKey) return;
    scrolledSelectionKeyRef.current = selectionKey;
    pointerSelectionRef.current = false;
    if (scrollViewportRef.current) scrollViewportRef.current.scrollTop = 0;
  }, [open, selectionKey]);

  const buildFlatItemsForQuery = useCallback(
    (nextQuery: string): readonly PaletteItem[] =>
      buildCommandPaletteSectionsModel({
        query: nextQuery,
        files: nextQuery === query ? files : [],
        textMatches: nextQuery === query ? textMatches : [],
        textQueries: history.queries,
        discoveryLimits: nextQuery === query ? discoveryLimits : DEFAULT_DISCOVERY_LIMITS,
        mode: currentMode,
        commands: currentCommands,
        projects,
        activeProjectId,
        pages,
        findResponse: nextQuery === query ? find.response : null,
        findPending: find.pending,
        findFailed: find.failed,
        pageSearchBatch: pageSearchBatch,
        pageSearchScopeKey,
      }).flatItems,
    [
      pageSearchScopeKey,
      activeProjectId,
      pages,
      currentCommands,
      currentMode,
      pageSearchBatch,
      projects,
      find.response,
      find.pending,
      find.failed,
      query,
      files,
      textMatches,
      history.queries,
      discoveryLimits,
    ],
  );
  const visibleRowsLoading =
    mode === "pages"
      ? visibleModel.pageSearchPending
      : mode === "chats"
        ? visibleModel.chatsPending || visibleModel.chatStatus === "searching"
        : mode === "root"
          ? visibleModel.chatsPending ||
            visibleModel.chatStatus === "searching" ||
            visibleModel.pageSearchPending ||
            fileSearch.loading ||
            textSearch.loading
          : mode === "files"
            ? fileSearch.loading
            : mode === "text"
              ? textSearch.loading
              : false;

  const preferredIndex = resetSelection || selectedIndex < 0 ? 0 : selectedIndex;
  const forwardIndex = resolveSelectableIndex(flatItems, preferredIndex, 1);
  const nextSelectedIndex =
    forwardIndex < 0 ? resolveSelectableIndex(flatItems, preferredIndex, -1) : forwardIndex;
  if (selectedIndex !== nextSelectedIndex) setSelectedIndex(nextSelectedIndex);

  useEffect(() => {
    if (pointerSelectionRef.current) {
      pointerSelectionRef.current = false;
      return;
    }
    if (selectedIndex < 0) return;
    const next = scrollViewportRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${selectedIndex}"]`,
    );
    next?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const changeScope = (nextMode: CommandMenuMode, focusInput = true) => {
    setSelectedIndex(0);
    setExpandedDiscovery(null);
    setPageStack([]);
    onChangeMode(nextMode);
    if (focusInput) inputRef.current?.focus();
  };

  const handleExecute = (item: PaletteItem) => {
    if (isPaletteItemDisabled(item)) return;
    if (item.kind === "more") {
      setSelectedIndex(flatItems.findIndex((candidate) => candidate.id === item.id));
      setExpandedDiscovery({
        key: discoveryKey,
        limits: {
          ...discoveryLimits,
          [item.scope]: Math.min(
            getDiscoveryResultLimit(item.scope),
            discoveryLimits[item.scope] + 5,
          ),
        },
      });
      inputRef.current?.focus();
      return;
    }
    if (item.kind === "command" && item.themeAction) {
      if (item.themeAction === "open") {
        setPageStack((pages) => [...pages, "themes"]);
        setQuery("");
        inputRef.current?.focus();
        return;
      }
      if (theme.execute(item.id)) onRequestClose();
      return;
    }
    if (item.kind === "command" && item.id === FILE_SEARCH_RETRY_ID) {
      fileSearchRetry?.run();
      return;
    }
    if (item.kind === "text-query") {
      setQuery(item.query);
      inputRef.current?.focus();
      return;
    }
    if (item.kind === "command" && item.id === "searchText") {
      setQuery("");
      onChangeMode("text");
      return;
    }
    if (item.kind === "text") history.commit(query);
    if (item.kind === "command" && item.id === "searchChats") {
      setQuery("");
      onChangeMode("chats");
      return;
    }

    if (item.kind === "command" && item.id === "searchPages") {
      setQuery("");
      onChangeMode("pages");
      return;
    }

    if (item.kind === "command" && item.id === "searchFiles") {
      setQuery("");
      onChangeMode("files");
      return;
    }

    onRequestClose();
    onExecute(item, query);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    pointerSelectionRef.current = false;
    if (
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      composingRef.current
    ) {
      event.stopPropagation();
      return;
    }
    if (isSearchOptionsFocusKey(event)) {
      event.preventDefault();
      const control =
        searchOptionsRef.current ??
        scopeControlsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      control?.focus();
      return;
    }
    const moveSelection = (direction: -1 | 1) => {
      if (flatItems.length === 0) return;
      const currentIndex = selectedIndex < 0 ? (direction > 0 ? -1 : 0) : selectedIndex;
      const nextIndex = resolveSelectableIndex(flatItems, currentIndex + direction, direction);
      if (nextIndex < 0) return;
      setSelectedIndex(nextIndex);
    };

    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && (event.metaKey || event.altKey)) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (event.metaKey) {
        setSelectedIndex(
          resolveSelectableIndex(
            flatItems,
            direction > 0 ? flatItems.length - 1 : 0,
            direction > 0 ? -1 : 1,
          ),
        );
        return;
      }
      const groupStarts = sections.map((_, index) =>
        sections.slice(0, index).reduce((total, section) => total + section.items.length, 0),
      );
      const currentGroup = groupStarts.findLastIndex((start) => start <= selectedIndex);
      const targetGroup = Math.max(0, Math.min(groupStarts.length - 1, currentGroup + direction));
      const nextIndex = resolveSelectableIndex(flatItems, groupStarts[targetGroup] ?? 0, 1);
      if (nextIndex >= 0) setSelectedIndex(nextIndex);
      return;
    }

    if (event.key === "ArrowDown" || (event.ctrlKey && (event.key === "j" || event.key === "n"))) {
      event.preventDefault();
      moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp" || (event.ctrlKey && (event.key === "k" || event.key === "p"))) {
      event.preventDefault();
      moveSelection(-1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      if (flatItems.length === 0) return;
      setSelectedIndex(resolveSelectableIndex(flatItems, 0, 1));
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      if (flatItems.length === 0) return;
      setSelectedIndex(resolveSelectableIndex(flatItems, flatItems.length - 1, -1));
      return;
    }

    if (!activePage && event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      changeScope(cycleCommandPaletteMode(mode, event.shiftKey ? -1 : 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = resolveQueryFreshAccept({
        liveQuery: query,
        rowsQuery: query,
        rows: flatItems,
        focusedIndex: selectedIndex,
        buildFreshRows: buildFlatItemsForQuery,
        getRowId: (item) => item.id,
        isRowAcceptable: (item) => !isPaletteItemDisabled(item),
        normalizeQuery: normalizeCommandPaletteSearchText,
      });
      if (result.status === "accepted") {
        handleExecute(result.row);
      }
      return;
    }

    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (hasOpenNodexFloatingEscapeLayer(event.currentTarget.ownerDocument)) return;
    event.preventDefault();
    if (activePage) {
      setPageStack((pages) => pages.slice(0, -1));
      setQuery("");
      return;
    }
    onRequestClose();
  };
  const activeDescendantId =
    selectedIndex >= 0 && selectedIndex < flatItems.length
      ? getPaletteItemDomId(listId, selectedIndex)
      : undefined;
  const showPageSearchStatus = visibleModel.showPageSearchStatus;
  // A search that can be retried says so in its selectable retry row instead.
  const fileSearchNotice =
    (mode === "files" || mode === "root") && fileSearch.incomplete && !fileSearchRetry
      ? describeFileSearchIncomplete(intl, fileSearch.incomplete)
      : null;
  const fileSearchNoticeRow = fileSearchNotice ? (
    <SearchStatusRow>{fileSearchNotice}</SearchStatusRow>
  ) : null;
  const showFileSearchStatus =
    (mode === "files" || mode === "root") && (fileSearch.loading || fileSearchNotice !== null);
  const hasVisibleSearchStatus =
    visibleModel.chatStatus !== null ||
    visibleModel.chatSearchTruncated ||
    showPageSearchStatus ||
    showFileSearchStatus ||
    ((mode === "root" || mode === "text") &&
      (textSearch.loading ||
        (textSearch.error !== null && !(mode === "root" && textSearch.error === "invalid-query"))));
  // Text shows its own delayed progress; every other scope shares the corner spinner.
  const searching = !activePage && mode !== "text" && visibleRowsLoading;

  return (
    <NodexTabsRoot
      value={mode}
      onValueChange={(value, details) => {
        const scope = scopes.find((candidate) => candidate.mode === value);
        if (!scope) return;
        changeScope(
          scope.mode,
          details.event.type !== "keydown" && details.event.type !== "focusin",
        );
      }}
      cmdk-root=""
      data-cmdk-root
      data-command-palette-surface
      className="@container relative flex h-[var(--command-menu-height,min(504px,90vh))] min-w-full select-none flex-col gap-1 overflow-hidden rounded-2xl bg-surface/65 p-1 pb-0 text-base text-token-foreground shadow-2xl ring-[0.5px] ring-token-border backdrop-blur-[24px]"
    >
      {!activePage && mode === "text" ? (
        <CommandPaletteTextHistoryRecorder
          key={JSON.stringify(historyScope)}
          query={query}
          history={history}
        />
      ) : null}
      <label cmdk-label="" htmlFor={inputId} id={labelId} className="sr-only">
        <FormattedMessage
          id="workbench.commandPaletteSurface.searchLabel"
          defaultMessage={"Command palette search"}
        />
      </label>
      <div className="-mx-1 flex shrink-0 items-center border-b-[0.5px] border-token-border px-4">
        <input
          ref={inputRef}
          cmdk-input=""
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-autocomplete="list"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeDescendantId}
          aria-labelledby={labelId}
          aria-description={
            activePage
              ? undefined
              : intl.formatMessage({
                  id: "workbench.commandPaletteSurface.searchKeyboardHint",
                  defaultMessage: "Tab switches search; F6 focuses search options",
                })
          }
          id={inputId}
          value={query}
          maxLength={mode === "text" ? 256 : undefined}
          onChange={(event) => {
            setExpandedDiscovery(null);
            setQuery(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          placeholder={
            activePage
              ? intl.formatMessage({
                  id: "workbench.commandPaletteSurface.searchThemes",
                  defaultMessage: "Search themes",
                })
              : getModePlaceholder(intl, mode)
          }
          aria-label={intl.formatMessage({
            id: "workbench.commandPaletteSurface.searchLabel",
            defaultMessage: "Command palette search",
          })}
          className="h-11.5 min-w-0 flex-1 rounded-none border-none bg-transparent pe-6 pb-1.5 text-lg text-token-foreground outline-none placeholder:text-tertiary"
        />
      </div>
      {/* Fades in only when a search outlasts a beat, so instant results never flash it. */}
      <span
        className={cn(
          "pointer-events-none absolute end-4 top-4 text-token-description-foreground transition-opacity",
          searching ? "opacity-100 delay-300 duration-150" : "opacity-0 duration-0",
        )}
        role={searching ? "progressbar" : undefined}
        aria-label={
          !searching
            ? undefined
            : mode === "files"
              ? intl.formatMessage({
                  id: "workbench.commandPaletteSurface.searchingFilesLabel",
                  defaultMessage: "Searching files",
                })
              : intl.formatMessage({
                  id: "workbench.commandPaletteSurface.searching",
                  defaultMessage: "Searching",
                })
        }
      >
        {searching ? <ActivitySpinnerIcon className="icon-sm" /> : null}
      </span>

      {activePage ? (
        <button
          type="button"
          className="flex h-[34px] shrink-0 items-center gap-2 px-3 text-sm text-token-description-foreground"
          aria-label={intl.formatMessage({
            id: "workbench.commandPaletteSurface.backToCommandMenu",
            defaultMessage: "Back to command menu",
          })}
          onClick={() => {
            setPageStack((pages) => pages.slice(0, -1));
            setQuery("");
            inputRef.current?.focus();
          }}
        >
          <BackIcon className="size-4" />
          <FormattedMessage id="workbench.commandPaletteSurface.theme" defaultMessage={"Theme"} />
        </button>
      ) : null}
      <NodexTabsPanel
        value={mode}
        tabIndex={-1}
        className="-mt-1 flex min-h-0 flex-1 flex-col outline-none"
      >
        <div
          ref={scrollViewportRef}
          cmdk-list=""
          role="listbox"
          tabIndex={-1}
          aria-label={intl.formatMessage({
            id: "workbench.commandPaletteSurface.suggestions",
            defaultMessage: "Suggestions",
          })}
          id={listId}
          aria-busy={visibleRowsLoading}
          className="relative flex min-h-0 flex-1 scroll-pt-8 flex-col gap-1 overflow-y-auto overscroll-contain pb-1 [scrollbar-width:none]"
        >
          {!activePage && mode === "text" ? (
            <CommandPaletteTextError result={textSearch} mode={mode} />
          ) : null}
          {sections.map((section) => {
            const startIndex = sections
              .slice(0, sections.indexOf(section))
              .reduce((sum, candidate) => sum + candidate.items.length, 0);
            return (
              <Fragment key={section.title}>
                {!activePage && mode === "root" && section.scope === "text" ? (
                  <CommandPaletteTextError result={textSearch} mode={mode} />
                ) : null}
                <PaletteSection
                  compact={mode === "root" && section.title !== "Top result"}
                  query={query}
                  textLabels={textLabels}
                  title={section.title}
                  showHeading={
                    mode !== "text" &&
                    !(activePage && section.title === "Suggested") &&
                    section.items[0]?.id !== FILE_SEARCH_RETRY_ID
                  }
                  items={section.items}
                  listId={listId}
                  selectedIndex={selectedIndex}
                  startIndex={startIndex}
                  onSelectIndex={(index) => {
                    pointerSelectionRef.current = true;
                    setSelectedIndex(index);
                  }}
                  onExecute={handleExecute}
                />
                {section.scope === "files" ? fileSearchNoticeRow : null}
              </Fragment>
            );
          })}
          {!activePage &&
          mode === "root" &&
          !sections.some((section) => section.scope === "text") ? (
            <CommandPaletteTextError result={textSearch} mode={mode} />
          ) : null}
          {visibleModel.chatStatus && visibleModel.chatStatus !== "searching" ? (
            <SearchStatusRow>
              {intl.formatMessage(CHAT_STATUS_LABELS[visibleModel.chatStatus])}
            </SearchStatusRow>
          ) : null}
          {showPageSearchStatus && visibleModel.pageSearchIndexing ? (
            <SearchStatusRow>
              <FormattedMessage
                id="workbench.commandPaletteSurface.stillIndexingPages"
                defaultMessage="Still indexing Pages. Some matches may not appear yet."
              />
            </SearchStatusRow>
          ) : null}
          {visibleModel.chatSearchTruncated ||
          (showPageSearchStatus && visibleModel.pageSearchTruncated) ? (
            <SearchStatusRow>{intl.formatMessage(MORE_MATCHES_LABEL)}</SearchStatusRow>
          ) : null}
          {showPageSearchStatus && visibleModel.pageSearchError ? (
            <SearchStatusRow>
              <FormattedMessage
                id="workbench.commandPaletteSurface.fullPageSearchUnavailable"
                defaultMessage={"Full Page search is unavailable"}
              />
            </SearchStatusRow>
          ) : null}
          {sections.some((section) => section.scope === "files") ? null : fileSearchNoticeRow}
          {fileSearch.loading && (mode === "files" || mode === "root") ? (
            <span className="sr-only" role="status">
              <FormattedMessage
                id="workbench.commandPaletteSurface.searchingFiles"
                defaultMessage={"Searching files…"}
              />
            </span>
          ) : null}
          {!activePage && (mode === "text" || mode === "root") ? (
            <CommandPaletteTextStatus
              result={textSearch}
              mode={mode}
              query={query}
              hasScope={Boolean(searchScope?.roots.length)}
              hasHistory={history.queries.length > 0}
            />
          ) : null}
          {mode !== "text" && flatItems.length === 0 && !searching && !hasVisibleSearchStatus ? (
            <div
              data-cmdk-empty
              className="absolute inset-0 flex items-center justify-center px-4 text-center text-lg text-token-description-foreground"
            >
              {mode === "files" && !hasFileScope
                ? intl.formatMessage({
                    id: "workbench.commandPaletteSurface.chooseFolderToSearch",
                    defaultMessage: "Choose a folder to search files",
                  })
                : getEmptyMessage(intl, mode, visibleModel.query)}
            </div>
          ) : null}
        </div>
      </NodexTabsPanel>
      {!activePage ? (
        <CommandPaletteScopeBar
          ref={scopeControlsRef}
          mode={mode}
          scopes={scopes}
          scopeLabel={(label) => formatPaletteSectionLabel(intl, label)}
          focusSearch={() => inputRef.current?.focus()}
          options={
            mode === "text" ? (
              <CommandPaletteTextToolbar
                history={history}
                selection={workspaceSelection}
                contextScope={fileSearchScope}
                contextLabel={projects.find((project) => project.id === activeProjectId)?.name}
                onSelectionChange={(selection) => {
                  onWorkspaceSelectionChange?.(selection);
                  setSelectedIndex(0);
                }}
                focusSearch={() => inputRef.current?.focus()}
                firstControlRef={searchOptionsRef}
              />
            ) : mode === "files" ? (
              <CommandPaletteWorkspaceToolbar
                selection={workspaceSelection}
                contextScope={fileSearchScope}
                contextLabel={projects.find((project) => project.id === activeProjectId)?.name}
                onSelectionChange={(selection) => {
                  onWorkspaceSelectionChange?.(selection);
                  setSelectedIndex(0);
                }}
                firstControlRef={searchOptionsRef}
              />
            ) : mode === "actions" ? null : (
              <CommandPalettePlaceMenu
                triggerRef={searchOptionsRef}
                projects={projects}
                selectedProject={selectedProject}
                onSelectProject={setPlaceProjectId}
                inputRef={inputRef}
              />
            )
          }
        />
      ) : null}
    </NodexTabsRoot>
  );
});
