import { useId, useRef, useState, type ReactNode } from "react";
import {
  abbreviateHomeDirectory,
  type LocalPathPresentationContext,
} from "../../../shared/local-path-presentation";
import { buildCommandPaletteTokenHighlightSegments } from "../../lib/command-palette-highlight";
import { formatCompactRelativeTime } from "../../lib/compact-relative-time";
import type {
  NativeConversationCandidate,
  NativeConversationSource,
} from "../../lib/native-conversation-import-model";
import { cn } from "../../lib/utils";
import { ActivitySpinnerIcon, AgentProviderIcon } from "../shared/icons";
import { NodexButton } from "../ui/button";
import {
  NodexDropdownActionRow,
  NodexDropdownSeparator,
  NodexOptionPicker,
  NodexSettingsDropdownTrigger,
  type NodexOptionPickerOption,
} from "../ui/dropdown";
import { NodexCheckbox } from "../ui/settings";
import { NodexTooltip } from "../ui/tooltip";

export const conversationTitle = (title: string) => title || "Untitled conversation";

export const conversationSourceName = (source: NativeConversationSource) =>
  source.backendKind === "claude" ? "Claude Code" : "Codex";

/** The query's words, marked where they appear; an empty query renders the text untouched. */
function ConversationMatchedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return text;
  return buildCommandPaletteTokenHighlightSegments(text, query).map((segment, index) =>
    segment.highlight ? (
      <mark
        key={index}
        className="rounded-xs bg-token-editor-find-match-background text-token-foreground"
      >
        {segment.text}
      </mark>
    ) : (
      segment.text
    ),
  );
}

function ConversationAgentMark({ source }: { source: NativeConversationSource }) {
  const name = conversationSourceName(source);
  return (
    <span role="img" aria-label={name} className="inline-flex shrink-0">
      <AgentProviderIcon kind={source.backendKind} className="size-3.5" />
    </span>
  );
}

export type ConversationImportRowState =
  | { readonly kind: "importing" }
  | { readonly kind: "opening" }
  | { readonly kind: "failed"; readonly message: string };

/** An unsettled attempt: importing again can only finish this exact request. */
export interface ConversationImportPendingAttempt {
  readonly cwd: string;
  readonly destination: string;
  readonly unsettled: string | null;
}

export function ConversationImportRow({
  candidate,
  query,
  pathContext,
  selected,
  cwd,
  pending,
  state,
  locked,
  canOpen,
  onToggle,
  onChooseFolder,
  onOpen,
}: {
  candidate: NativeConversationCandidate;
  /** What the list is searching for, marked in the title and folder. */
  query: string;
  pathContext: LocalPathPresentationContext | null;
  selected: boolean;
  /** The directory a new copy would use; null while a missing original has no replacement. */
  cwd: string | null;
  pending: ConversationImportPendingAttempt | null;
  state: ConversationImportRowState | undefined;
  locked: boolean;
  canOpen: boolean;
  onToggle: () => void;
  onChooseFolder: () => void;
  onOpen: () => void;
}) {
  const titleId = useId();
  const checkboxId = useId();
  const title = conversationTitle(candidate.title);
  const { imported } = candidate;
  const missing = !candidate.cwdAvailable;
  const folder = pending?.cwd ?? cwd;
  const selectable = !imported;
  const titleContent = <ConversationMatchedText text={title} query={query} />;

  let action: ReactNode = null;
  if (imported) {
    action = canOpen ? (
      <NodexButton size="xs" variant="secondary" disabled={locked} onClick={onOpen}>
        {state?.kind === "opening" ? "Opening…" : "Open"}
      </NodexButton>
    ) : (
      <span className="shrink-0 text-xs text-token-description-foreground">Imported</span>
    );
  } else if (state?.kind === "importing") {
    action = (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-token-text-secondary">
        <ActivitySpinnerIcon className="icon-2xs" />
        Importing…
      </span>
    );
  } else if (selected && missing && !pending) {
    action = cwd ? (
      <NodexTooltip tooltipContent={`Replaces ${candidate.cwd}`}>
        <NodexButton
          size="xs"
          variant="ghost"
          className="relative z-[1]"
          aria-label="Change folder"
          disabled={locked}
          onClick={onChooseFolder}
        >
          Change
        </NodexButton>
      </NodexTooltip>
    ) : (
      <NodexButton
        size="xs"
        variant="secondary"
        className="relative z-[1]"
        disabled={locked}
        onClick={onChooseFolder}
      >
        Choose folder
      </NodexButton>
    );
  }

  const folderCell = (
    <span
      className={cn(
        "block min-w-0 truncate text-left text-xs [direction:rtl]",
        folder ? "text-token-text-secondary" : "text-danger",
      )}
    >
      {folder ? (
        <bdi dir="ltr">
          <ConversationMatchedText
            text={abbreviateHomeDirectory(folder, pathContext)}
            query={query}
          />
        </bdi>
      ) : (
        "Folder missing"
      )}
    </span>
  );

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn(
        // Inset so the tint sits evenly in the card whether or not a scrollbar holds its gutter.
        "relative mx-1.5 flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-1.5",
        selected ? "bg-token-foreground/5" : selectable && "hover:bg-token-list-hover-background",
      )}
    >
      <div className="flex min-h-6 min-w-0 items-center gap-3">
        {selectable ? (
          <NodexCheckbox
            id={checkboxId}
            ariaLabel={title}
            className="relative z-[1]"
            checked={selected}
            disabled={locked}
            onCheckedChange={onToggle}
          />
        ) : (
          <span aria-hidden className="size-3.5 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <ConversationAgentMark source={candidate.source} />
          {selectable ? (
            // The label's overlay makes the whole row a target for its checkbox.
            <label
              id={titleId}
              htmlFor={checkboxId}
              className="min-w-0 cursor-interaction truncate text-sm text-token-text-primary after:absolute after:inset-0 after:content-['']"
            >
              {titleContent}
            </label>
          ) : (
            <span id={titleId} className="min-w-0 truncate text-sm text-token-text-secondary">
              {titleContent}
            </span>
          )}
          {candidate.source.profileName ? (
            <span className="shrink-0 text-xs text-token-description-foreground">
              {candidate.source.profileName}
            </span>
          ) : null}
        </div>
        {action}
        <NodexTooltip tooltipContent={folder ?? candidate.cwd}>
          {selectable ? (
            <label
              htmlFor={checkboxId}
              className="relative z-[1] w-[27%] max-w-52 shrink-0 cursor-interaction"
            >
              {folderCell}
            </label>
          ) : (
            <span className="w-[27%] max-w-52 shrink-0">{folderCell}</span>
          )}
        </NodexTooltip>
        <time
          className="w-7 shrink-0 text-right text-xs text-token-description-foreground tabular-nums"
          dateTime={new Date(candidate.updatedAt).toISOString()}
        >
          {formatCompactRelativeTime(candidate.updatedAt)}
        </time>
      </div>
      {state?.kind === "failed" ? (
        <p role="alert" className="pl-[26px] text-xs text-danger">
          {state.message}
        </p>
      ) : pending && state?.kind !== "importing" && !imported ? (
        <p className="flex min-w-0 flex-col pl-[26px] text-xs">
          <span role="alert" className="text-danger">
            {pending.unsettled ?? "This import hasn’t finished."}
          </span>
          <span className="text-token-description-foreground">
            Import again to finish it in {pending.destination}.
          </span>
        </p>
      ) : null}
    </div>
  );
}

const RENDERED_ROWS_STEP = 100;

/**
 * Scrolls a list of any length: rows mount in steps as they near the viewport, so a whole history
 * stays cheap to filter. Keying it by what the list shows starts each new result at the top.
 */
export function ConversationImportRows<Row>({
  rows,
  renderRow,
  children,
}: {
  rows: readonly Row[];
  renderRow: (row: Row) => ReactNode;
  /** Notices that lead the list, such as a source that could not be read. */
  children?: ReactNode;
}) {
  const [rendered, setRendered] = useState(RENDERED_ROWS_STEP);
  const scroller = useRef<HTMLDivElement>(null);
  const observeSentinel = (sentinel: HTMLDivElement) => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setRendered((current) => current + RENDERED_ROWS_STEP);
      },
      { root: scroller.current, rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  };

  return (
    <div
      ref={scroller}
      className="flex h-full min-h-0 flex-col overflow-y-auto py-1 [scrollbar-gutter:stable]"
    >
      {children}
      {rows.slice(0, rendered).map(renderRow)}
      {/* Each step mounts a new sentinel, so one still in range reports again. */}
      {rendered < rows.length ? (
        <div key={rendered} ref={observeSentinel} aria-hidden className="h-px shrink-0" />
      ) : null}
    </div>
  );
}

/**
 * One way to narrow the list. Quiet while it lets everything through; tinted once it narrows, so
 * what is hiding rows can be read from the toolbar.
 */
export function ConversationImportFilterPicker({
  label,
  allValue,
  value,
  valueLabel,
  options,
  search = false,
  disabled = false,
  onValueChange,
}: {
  /** Names the dimension while nothing is chosen, and names the control. */
  label: string;
  allValue: string;
  value: string;
  valueLabel: string | null;
  options: readonly NodexOptionPickerOption[];
  search?: boolean;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const active = value !== allValue;
  return (
    <NodexOptionPicker
      value={value}
      options={options}
      disabled={disabled}
      onValueChange={onValueChange}
      {...(search
        ? {
            search: "filter" as const,
            searchPlaceholder: `Search ${label.toLowerCase()}s…`,
            contentClassName: "w-80 max-w-[80vw]",
            contentMaxHeight: "tall" as const,
          }
        : { contentWidth: "sm" as const })}
      align="end"
      triggerButton={
        <NodexSettingsDropdownTrigger
          aria-label={`Filter by ${label.toLowerCase()}`}
          className={cn(
            "max-w-36 shrink-0",
            active ? "bg-token-foreground/5" : "text-token-text-secondary",
          )}
        >
          <span className="min-w-0 truncate">{active ? valueLabel : label}</span>
        </NodexSettingsDropdownTrigger>
      }
    />
  );
}

export interface ConversationImportDestinationOption {
  /** A Project ID, or null for Projectless. */
  readonly projectId: string | null;
  readonly label: string;
}

export interface ConversationImportDestinations {
  readonly options: readonly ConversationImportDestinationOption[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
}

const PROJECTLESS = "projectless";

export function ConversationImportDestinationPicker({
  destinations,
  value,
  onValueChange,
  disabled,
}: {
  destinations: ConversationImportDestinations;
  value: string | null;
  onValueChange: (projectId: string | null) => void;
  disabled: boolean;
}) {
  const options = destinations.options.map((option) => ({
    value: option.projectId ?? PROJECTLESS,
    label: option.label,
  }));
  return (
    <NodexOptionPicker
      value={value ?? PROJECTLESS}
      options={options}
      search="filter"
      disabled={disabled}
      onValueChange={(next) => onValueChange(next === PROJECTLESS ? null : next)}
      footer={
        destinations.hasMore ? (
          <>
            <NodexDropdownSeparator />
            <NodexDropdownActionRow
              disabled={destinations.loadingMore}
              onClick={destinations.loadMore}
            >
              {destinations.loadingMore ? "Loading…" : "Load more projects"}
            </NodexDropdownActionRow>
          </>
        ) : null
      }
      triggerButton={
        <NodexSettingsDropdownTrigger aria-label="Import destination">
          {options.find((option) => option.value === (value ?? PROJECTLESS))?.label}
        </NodexSettingsDropdownTrigger>
      }
    />
  );
}

/** The list's own last row: it says what is selected and acts on it, wherever the list is scrolled. */
export function ConversationImportFooter({
  selectAll,
  summary,
  children,
}: {
  selectAll: {
    checked: boolean;
    indeterminate: boolean;
    disabled: boolean;
    onCheckedChange: (checked: boolean) => void;
  };
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label="Import selection"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
    >
      <NodexCheckbox
        ariaLabel="Select all conversations"
        checked={selectAll.checked}
        indeterminate={selectAll.indeterminate}
        disabled={selectAll.disabled}
        onCheckedChange={selectAll.onCheckedChange}
      />
      <div className="flex min-w-0 flex-1 items-center gap-1 text-xs text-token-text-secondary">
        {summary}
      </div>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}
