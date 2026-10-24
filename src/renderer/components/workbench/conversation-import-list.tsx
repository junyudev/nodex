import { useId, type ReactNode } from "react";
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
} from "../ui/dropdown";
import { NodexCheckbox } from "../ui/settings";
import { NodexTooltip } from "../ui/tooltip";

export const conversationTitle = (title: string) => title || "Untitled conversation";

export const conversationSourceName = (source: NativeConversationSource) =>
  source.backendKind === "claude" ? "Claude Code" : "Codex";

/** Absolute paths keep their trailing folders visible when truncated, aligned like LTR text. */
function ConversationPath({ path }: { path: string }) {
  return (
    <span className="block min-w-0 truncate text-left [direction:rtl]">
      <bdi dir="ltr">{path}</bdi>
    </span>
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

  let action: ReactNode = null;
  if (imported) {
    action = canOpen ? (
      <NodexButton size="sm" variant="secondary" disabled={locked} onClick={onOpen}>
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
          size="sm"
          variant="ghost"
          aria-label="Change folder"
          disabled={locked}
          onClick={onChooseFolder}
        >
          Change
        </NodexButton>
      </NodexTooltip>
    ) : (
      <NodexButton size="sm" variant="secondary" disabled={locked} onClick={onChooseFolder}>
        Choose folder
      </NodexButton>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="flex min-w-0 items-center gap-3 px-4 py-2.5"
    >
      {imported ? (
        <span aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <NodexCheckbox
          id={checkboxId}
          checked={selected}
          disabled={locked}
          onCheckedChange={onToggle}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <ConversationAgentMark source={candidate.source} />
          {imported ? (
            <span id={titleId} className="min-w-0 truncate text-sm text-token-text-primary">
              {title}
            </span>
          ) : (
            <label
              id={titleId}
              htmlFor={checkboxId}
              className="min-w-0 cursor-interaction truncate text-sm text-token-text-primary"
            >
              {title}
            </label>
          )}
          {candidate.source.profileName ? (
            <span className="shrink-0 text-xs text-token-description-foreground">
              {candidate.source.profileName}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-token-text-secondary">
          <ConversationPath path={folder ?? candidate.cwd} />
          {missing && !folder ? <span className="shrink-0 text-danger">Folder missing</span> : null}
        </div>
        {state?.kind === "failed" ? (
          <p role="alert" className="text-xs text-danger">
            {state.message}
          </p>
        ) : pending && state?.kind !== "importing" && !imported ? (
          <p className="flex min-w-0 flex-col text-xs">
            <span role="alert" className="text-danger">
              {pending.unsettled ?? "This import hasn’t finished."}
            </span>
            <span className="text-token-description-foreground">
              Import again to finish it in {pending.destination}.
            </span>
          </p>
        ) : null}
      </div>
      <time
        className="shrink-0 text-xs text-token-description-foreground tabular-nums"
        dateTime={new Date(candidate.updatedAt).toISOString()}
      >
        {formatCompactRelativeTime(candidate.updatedAt)}
      </time>
      {action}
    </div>
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

/**
 * Present whenever the list is, so selecting never changes the page's height. It sticks to the
 * bottom of the Settings scroll area to stay reachable from anywhere in a long list.
 */
export function ConversationImportFooter({
  selectAll,
  summary,
  children,
}: {
  selectAll: { checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void };
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label="Import selection"
      className={cn(
        "sticky bottom-0 z-[1] flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-b-2xl px-4 py-2.5",
        "before:pointer-events-none before:absolute before:inset-x-4 before:-top-px before:h-px",
        "before:bg-token-border before:content-['']",
      )}
      style={{ backgroundColor: "var(--color-background-panel, var(--color-token-bg-fog))" }}
    >
      <NodexCheckbox
        ariaLabel="Select all conversations"
        checked={selectAll.checked}
        disabled={selectAll.disabled}
        onCheckedChange={selectAll.onCheckedChange}
      />
      <p role="status" className="min-w-0 flex-1 truncate text-xs text-token-text-secondary">
        {summary}
      </p>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}
