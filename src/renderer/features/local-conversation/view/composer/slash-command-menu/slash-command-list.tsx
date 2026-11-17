import { useIntl } from "@/lib/i18n";
import { useEffect, useRef } from "react";
import { mergeFuzzyMatchSegments, segmentFuzzyMatch } from "@/lib/fuzzy-match-segments";
import { cn } from "@/lib/utils";
import { ComposerSuggestionRow } from "../composer-suggestion-surface";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandGroup,
  ComposerSlashCommandHighlightSource,
  ComposerSlashCommandMatch,
} from "./slash-command-types";

interface SlashCommandListProps {
  groups: readonly ComposerSlashCommandGroup[];
  query: string;
  /** Commands are still arriving, such as skills being discovered. */
  loading?: boolean;
  highlightedCommandId: string | null;
  highlightedSource: ComposerSlashCommandHighlightSource;
  onHighlight: (commandId: string, source: ComposerSlashCommandHighlightSource) => void;
  onSelect: (command: ComposerSlashCommand) => void;
}

export function SlashCommandList({
  groups,
  query,
  loading = false,
  highlightedCommandId,
  highlightedSource,
  onHighlight,
  onSelect,
}: SlashCommandListProps) {
  const intl = useIntl();
  if (groups.length === 0) {
    return loading ? (
      <SlashCommandListLoading />
    ) : (
      <div className="px-row-x py-row-y text-sm text-token-input-placeholder-foreground">
        {intl.formatMessage({
          id: "conversation.slashCommandList.empty",
          defaultMessage: "No commands",
        })}
      </div>
    );
  }

  // A heading separates sections only when more than one is showing.
  const showHeadings = groups.length > 1;
  return (
    <div className="vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto">
      {groups.map((group, index) => (
        <div key={group.id} className="flex flex-col">
          {showHeadings && group.label !== null ? (
            <div
              className={cn(
                "text-token-description-foreground sticky top-0 z-10 bg-token-dropdown-background/95 px-row-x py-1 text-sm backdrop-blur-sm",
                index > 0 && "pt-2",
              )}
            >
              {group.label}
            </div>
          ) : null}
          {group.matches.map((match) => (
            <SlashCommandRow
              key={match.command.id}
              match={match}
              query={query}
              selected={match.command.id === highlightedCommandId}
              shouldScrollIntoView={highlightedSource !== "pointer"}
              onHighlight={onHighlight}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function SlashCommandRow({
  match,
  query,
  selected,
  shouldScrollIntoView,
  onHighlight,
  onSelect,
}: {
  match: ComposerSlashCommandMatch;
  query: string;
  selected: boolean;
  shouldScrollIntoView: boolean;
  onHighlight: (commandId: string, source: ComposerSlashCommandHighlightSource) => void;
  onSelect: (command: ComposerSlashCommand) => void;
}) {
  const { command } = match;
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const disabled = command.isEnabled === false;
  useEffect(() => {
    if (!selected) return;
    if (!shouldScrollIntoView) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected, shouldScrollIntoView]);

  return (
    <ComposerSuggestionRow
      ref={rowRef}
      highlighted={selected}
      disabled={disabled}
      data-slash-command-row={command.id}
      className="disabled:cursor-not-allowed disabled:opacity-45"
      onHighlight={() => onHighlight(command.id, "pointer")}
      onClick={() => {
        if (disabled) return;
        onSelect(command);
      }}
    >
      <div className="flex w-full min-w-0 items-center gap-2">
        {command.icon}
        <div
          className={cn("truncate", command.description ? "min-w-0 max-w-[60%]" : "min-w-0 flex-1")}
        >
          <SlashCommandTitle title={match.title} query={query} />
        </div>
        {command.description ? (
          <span className="min-w-0 flex-1 truncate text-sm text-token-description-foreground">
            {command.description}
          </span>
        ) : null}
        {command.trailing ? (
          <div className="ms-auto flex shrink-0 items-center gap-2">{command.trailing}</div>
        ) : null}
      </div>
    </ComposerSuggestionRow>
  );
}

/** Characters the query matched keep the title color; the rest recede. */
function SlashCommandTitle({ title, query }: { title: string; query: string }) {
  const runs = mergeFuzzyMatchSegments(segmentFuzzyMatch(title, query));
  const anyMatch = runs.some((run) => run.isMatch);
  return runs.map((run, index) =>
    run.text.trim() === "" ? (
      run.text
    ) : (
      <span
        key={index}
        className={!run.isMatch && anyMatch ? "text-token-description-foreground" : undefined}
      >
        {run.text}
      </span>
    ),
  );
}

function SlashCommandListLoading() {
  const intl = useIntl();
  return (
    <div role="status">
      <span className="sr-only">
        {intl.formatMessage({
          id: "conversation.slashCommandList.loading",
          defaultMessage: "Loading suggestions",
        })}
      </span>
      <div
        aria-hidden="true"
        className="flex w-full items-center gap-2 px-row-x py-row-y text-sm text-token-description-foreground"
      >
        <div className="size-5 shrink-0 rounded-md bg-token-foreground/10 motion-safe:animate-pulse" />
        <span className="h-4 w-2/3 rounded-md bg-token-foreground/10 motion-safe:animate-pulse" />
      </div>
    </div>
  );
}
