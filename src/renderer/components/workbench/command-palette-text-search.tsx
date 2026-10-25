import { Fragment, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type {
  WorkspaceTextSearchErrorCode,
  WorkspaceTextSearchMatch,
} from "../../../shared/workspace-text-search";
import {
  ActivitySpinnerIcon,
  DropdownChevronIcon,
  FileIcon,
  HistoryIcon,
} from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  commandPaletteWorkspaceScope,
  COMMAND_PALETTE_CONTEXT_SELECTION,
} from "@/lib/command-palette-workspace-selection";
import type { WorkspaceTextSearchHistoryController } from "@/lib/workspace-text-search-history";
import type { WorkspaceTextSearchResult } from "@/lib/use-workspace-text-search";
import {
  CommandPaletteWorkspaceToolbar,
  COMMAND_PALETTE_SEARCH_OPTION_CLASS_NAME,
  type CommandPaletteWorkspaceToolbarProps,
} from "./command-palette-workspace-toolbar";

export function CommandPaletteTextToolbar({
  history,
  focusSearch,
  ...workspace
}: CommandPaletteWorkspaceToolbarProps & {
  readonly history: WorkspaceTextSearchHistoryController;
  readonly focusSearch: () => void;
}) {
  const scope = commandPaletteWorkspaceScope(
    workspace.selection ?? COMMAND_PALETTE_CONTEXT_SELECTION,
    workspace.contextScope ?? null,
  );
  const maskId = useId();
  const maskInput = useRef<HTMLInputElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <>
      <CommandPaletteWorkspaceToolbar {...workspace} />
      {scope?.roots.length ? (
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <label htmlFor={maskId} className="shrink-0 text-sm text-tertiary">
            File types
          </label>
          <div className="flex min-w-0 items-center">
            <div className="w-28 min-w-0 shrink">
              <input
                ref={maskInput}
                id={maskId}
                value={history.fileMask}
                maxLength={256}
                placeholder="*.ts"
                spellCheck={false}
                autoComplete="off"
                className="h-7 w-full min-w-0 rounded-md border border-border-primary-outline bg-transparent px-2 text-sm text-token-foreground outline-none placeholder:text-tertiary"
                onChange={(event) => history.setFileMask(event.currentTarget.value)}
                onBlur={(event) => history.commit(undefined, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                    event.stopPropagation();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    history.commit(undefined, event.currentTarget.value);
                    focusSearch();
                    return;
                  }
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.stopPropagation();
                  if (event.key !== "ArrowDown" || history.masks.length === 0) return;
                  event.preventDefault();
                  setHistoryOpen(true);
                }}
              />
            </div>
            {history.masks.length > 0 ? (
              <NodexDropdownMenu
                open={historyOpen}
                onOpenChange={setHistoryOpen}
                finalFocus={maskInput}
                align="end"
                contentWidth="menuBounded"
                triggerButton={
                  <button
                    type="button"
                    className={`${COMMAND_PALETTE_SEARCH_OPTION_CLASS_NAME} shrink-0`}
                    aria-label="Previous file types"
                  >
                    <DropdownChevronIcon className="icon-xs shrink-0" />
                  </button>
                }
              >
                {history.masks.map((mask) => (
                  <NodexDropdownItem key={mask} onSelect={() => history.commit(undefined, mask)}>
                    {mask}
                  </NodexDropdownItem>
                ))}
              </NodexDropdownMenu>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

const basename = (path: string) => path.split(/[\\/]/u).at(-1) || path;

/** Duplicate basenames gain their relative path, plus a root label across multiple roots. */
export function workspaceTextSearchResultLabels(
  matches: readonly WorkspaceTextSearchMatch[],
  roots: readonly string[],
): ReadonlyMap<string, string> {
  const pathsByName = new Map<string, Set<string>>();
  for (const match of matches) {
    const name = basename(match.path);
    const paths = pathsByName.get(name) ?? new Set<string>();
    paths.add(match.path);
    pathsByName.set(name, paths);
  }
  return new Map(
    matches.map((match) => {
      const name = basename(match.path);
      const label =
        (pathsByName.get(name)?.size ?? 0) > 1
          ? `${roots.length > 1 ? `${basename(match.root)}/` : ""}${match.relativePath}`
          : name;
      return [match.path, label];
    }),
  );
}

export function CommandPaletteTextRow({
  match,
  pathLabel,
}: {
  readonly match: WorkspaceTextSearchMatch;
  readonly pathLabel?: string;
}) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <FileIcon className="icon-xs shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-token-foreground select-text">
        {match.matchRanges.map((range, index) => (
          <Fragment key={`${range.start}:${range.end}`}>
            {match.preview.slice(match.matchRanges[index - 1]?.end ?? 0, range.start)}
            <mark className="rounded-xs bg-token-editor-find-match-background text-token-foreground">
              {match.preview.slice(range.start, range.end)}
            </mark>
          </Fragment>
        ))}
        {match.preview.slice(match.matchRanges.at(-1)?.end ?? 0)}
      </span>
      <span className="semantic-text-secondary flex max-w-1/3 shrink-0 text-sm">
        <NodexTooltip tooltipContent={match.path}>
          <span className="truncate">{pathLabel ?? basename(match.path)}</span>
        </NodexTooltip>
        <span className="shrink-0">:{match.line}</span>
      </span>
    </div>
  );
}

export function CommandPaletteTextHistoryRow({ query }: { readonly query: string }) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <HistoryIcon className="icon-xs shrink-0" />
      <span className="min-w-0 flex-1 truncate">{query}</span>
    </div>
  );
}

export function workspaceTextSearchErrorMessage(code: WorkspaceTextSearchErrorCode): string {
  switch (code) {
    case "invalid-query":
      return "Use a single line with at most 256 characters";
    case "invalid-file-mask":
      return "Check the pattern in File types";
    case "missing-ripgrep":
      return "Install ripgrep on the selected computer to search file contents";
    case "unsupported-host":
      return "File content search is unavailable on this host";
    case "search-failed":
      return "Unable to search files. Try again";
  }
}

function DelayedTextSearchProgress({ centered }: { readonly centered: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timeout = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timeout);
  }, []);
  if (!visible) return null;
  return (
    <span
      role="progressbar"
      aria-label="Find in files"
      className={
        centered
          ? "pointer-events-none absolute inset-0 flex items-center justify-center"
          : undefined
      }
    >
      <ActivitySpinnerIcon className={centered ? "icon-sm" : "icon-xxs"} />
    </span>
  );
}

/** Search errors stay in the result flow, including when usable matches precede a failure. */
export function CommandPaletteTextError({
  result,
  mode,
}: {
  readonly result: WorkspaceTextSearchResult;
  readonly mode: "root" | "text";
}) {
  if (!result.error || (mode === "root" && result.error === "invalid-query")) return null;
  return (
    <div
      role="alert"
      data-cmdk-empty
      className="flex min-h-8 items-center px-2.5 py-1.5 text-center text-lg/1.4 text-tertiary whitespace-pre-wrap"
    >
      {workspaceTextSearchErrorMessage(result.error)}
    </div>
  );
}

/** Status is separate from selectable rows so pending work never steals keyboard selection. */
export function CommandPaletteTextStatus({
  result,
  mode,
  query,
  hasScope,
  hasHistory = false,
}: {
  readonly result: WorkspaceTextSearchResult;
  readonly mode: "root" | "text";
  readonly query: string;
  readonly hasScope: boolean;
  readonly hasHistory?: boolean;
}) {
  if (mode === "root") {
    return result.loading ? (
      <span className="sr-only" role="progressbar" aria-label="Find in files" />
    ) : null;
  }
  const message = !hasScope
    ? "Choose a folder to search files"
    : result.error
      ? null
      : query.trim().length === 0
        ? hasHistory
          ? null
          : "Type to search files"
        : !result.loading && result.matches.length === 0
          ? "No matches"
          : null;
  return (
    <>
      {message ? (
        <div
          role="status"
          data-cmdk-empty
          className="absolute inset-0 flex items-center justify-center px-4 text-center text-lg text-token-description-foreground"
        >
          {message}
        </div>
      ) : null}
      {result.loading ? (
        <div className="semantic-text-secondary px-2 py-2 text-xs">
          <DelayedTextSearchProgress
            key={result.requestKey}
            centered={result.matches.length === 0}
          />
        </div>
      ) : null}
      {!result.loading && result.limited ? (
        <div role="status" className="semantic-text-secondary px-2 py-2 text-xs">
          Showing first 100 matching lines
        </div>
      ) : null}
    </>
  );
}

/** Mount once per Text scope; leaving it records only the latest completed input. */
export function CommandPaletteTextHistoryRecorder({
  query,
  history,
}: {
  readonly query: string;
  readonly history: WorkspaceTextSearchHistoryController;
}) {
  const record = useEffectEvent(() => history.commit(query, history.fileMask));
  useEffect(() => () => record(), []);
  return null;
}
