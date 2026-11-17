import { useIntl } from "@/lib/i18n";
import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRightIcon } from "@/components/shared/icons";
import { NodexDropdownSelectedIcon } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { mergeFuzzyMatchSegments, segmentFuzzyMatch } from "@/lib/fuzzy-match-segments";
import { cn } from "@/lib/utils";
import { ComposerSuggestionRow } from "../composer-suggestion-surface";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandGroup,
  ComposerSlashHighlightSource,
  ComposerSlashSubmenuItem,
  ComposerSlashSubmenuSectionView,
} from "./slash-command-types";

interface SlashMenuHighlight {
  rowId: string | null;
  source: ComposerSlashHighlightSource;
  onHighlight: (rowId: string, source: ComposerSlashHighlightSource) => void;
}

/** The chat's commands, skills and Agent commands for the typed query. */
export function SlashCommandList({
  groups,
  query,
  loading = false,
  highlight,
  onSelect,
}: {
  groups: readonly ComposerSlashCommandGroup[];
  query: string;
  /** Commands are still arriving, such as skills being discovered. */
  loading?: boolean;
  highlight: SlashMenuHighlight;
  onSelect: (command: ComposerSlashCommand) => void;
}) {
  const intl = useIntl();
  if (groups.length === 0) {
    return loading ? (
      <SlashMenuLoading />
    ) : (
      <SlashMenuMessage>
        {intl.formatMessage({
          id: "conversation.slashCommandList.empty",
          defaultMessage: "No commands",
        })}
      </SlashMenuMessage>
    );
  }

  // A heading separates sections only when more than one is showing.
  const showHeadings = groups.length > 1;
  return (
    <SlashMenuScrollArea>
      {groups.map((group, index) => (
        <div key={group.id} className="flex flex-col">
          {showHeadings && group.label !== null ? (
            <SlashMenuHeading first={index === 0}>{group.label}</SlashMenuHeading>
          ) : null}
          {group.matches.map(({ command, title }) => (
            <SlashMenuRow
              key={command.id}
              rowId={command.id}
              highlight={highlight}
              icon={command.icon}
              title={title}
              query={query}
              description={command.description}
              trailing={
                command.trailing ??
                (command.action.kind === "submenu" ? (
                  <ChevronRightIcon className="icon-xs shrink-0 text-token-description-foreground" />
                ) : null)
              }
              disabled={command.isEnabled === false}
              onChoose={() => onSelect(command)}
            />
          ))}
        </div>
      ))}
    </SlashMenuScrollArea>
  );
}

/** A command's choices, listed in place of the commands while its slash query stays open. */
export function SlashSubmenuList({
  sections,
  query,
  icon,
  highlight,
  onSelect,
}: {
  sections: readonly ComposerSlashSubmenuSectionView[];
  query: string;
  /** The command's own icon, shown on rows that have none of their own. */
  icon: ReactNode;
  highlight: SlashMenuHighlight;
  onSelect: (item: ComposerSlashSubmenuItem) => void;
}) {
  const intl = useIntl();
  const visible = sections.filter((section) => section.items.length > 0 || section.emptyState);
  if (visible.length === 0) {
    return sections.some((section) => section.loading) ? (
      <SlashMenuLoading />
    ) : (
      <SlashMenuMessage>
        {query.trim()
          ? intl.formatMessage({
              id: "conversation.slashCommandList.noMatches",
              defaultMessage: "No matches",
            })
          : intl.formatMessage({
              id: "conversation.slashCommandList.noChoices",
              defaultMessage: "Nothing to choose here",
            })}
      </SlashMenuMessage>
    );
  }

  const showHeadings = visible.length > 1;
  return (
    <SlashMenuScrollArea>
      {visible.map((section, index) => (
        <div key={section.id} className="flex flex-col">
          {showHeadings && section.title !== null ? (
            <SlashMenuHeading first={index === 0}>{section.title}</SlashMenuHeading>
          ) : null}
          {section.items.length === 0 ? (
            <SlashMenuMessage>{section.emptyState}</SlashMenuMessage>
          ) : null}
          {section.items.map((item) => (
            <SlashMenuRow
              key={item.id}
              rowId={item.id}
              highlight={highlight}
              icon={item.icon ?? icon}
              title={item.title}
              query={query}
              description={item.description}
              trailing={
                item.trailing || item.current ? (
                  <>
                    {item.trailing}
                    {item.current ? <NodexDropdownSelectedIcon /> : null}
                  </>
                ) : null
              }
              disabled={item.disabled === true}
              tooltip={item.tooltip}
              {...(item.run ? { onChoose: () => onSelect(item) } : {})}
            />
          ))}
        </div>
      ))}
    </SlashMenuScrollArea>
  );
}

function SlashMenuScrollArea({ children }: { children: ReactNode }) {
  return (
    <div className="vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto">
      {children}
    </div>
  );
}

function SlashMenuHeading({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "text-token-description-foreground sticky top-0 z-10 bg-token-dropdown-background/95 px-row-x py-1 text-sm backdrop-blur-sm",
        !first && "pt-2",
      )}
    >
      {children}
    </div>
  );
}

function SlashMenuMessage({ children }: { children: ReactNode }) {
  return (
    <div className="px-row-x py-row-y text-sm text-token-input-placeholder-foreground">
      {children}
    </div>
  );
}

/**
 * One menu row. Rows without `onChoose` only report state; disabled rows stay listed with their
 * reason. The highlight follows the keyboard and the pointer.
 */
function SlashMenuRow({
  rowId,
  highlight,
  icon,
  title,
  query,
  description,
  trailing,
  disabled,
  tooltip,
  onChoose,
}: {
  rowId: string;
  highlight: SlashMenuHighlight;
  icon: ReactNode;
  title: string;
  query: string;
  description?: string | null | undefined;
  trailing: ReactNode;
  disabled: boolean;
  tooltip?: string | null | undefined;
  onChoose?: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const choosable = onChoose !== undefined && !disabled;
  const selected = choosable && highlight.rowId === rowId;
  const scrollIntoView = selected && highlight.source !== "pointer";
  useEffect(() => {
    if (scrollIntoView) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [scrollIntoView]);

  const content = (
    <div className="flex w-full min-w-0 items-center gap-2">
      {icon}
      <div className={cn("truncate", description ? "min-w-0 max-w-[60%]" : "min-w-0 flex-1")}>
        <SlashMenuTitle title={title} query={query} />
      </div>
      {description ? (
        <span className="min-w-0 flex-1 truncate text-sm text-token-description-foreground">
          {description}
        </span>
      ) : null}
      {trailing ? <div className="ms-auto flex shrink-0 items-center gap-2">{trailing}</div> : null}
    </div>
  );
  const row = choosable ? (
    <ComposerSuggestionRow
      ref={rowRef}
      highlighted={selected}
      data-slash-command-row={rowId}
      onHighlight={() => highlight.onHighlight(rowId, "pointer")}
      onClick={onChoose}
    >
      {content}
    </ComposerSuggestionRow>
  ) : (
    <div
      data-slash-command-row={rowId}
      aria-disabled={disabled || undefined}
      className={cn(
        "w-full shrink-0 px-row-x py-row-y text-left text-sm text-token-foreground",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      {content}
    </div>
  );
  return tooltip ? (
    <NodexTooltip tooltipContent={tooltip} delayOpen side="right">
      {row}
    </NodexTooltip>
  ) : (
    row
  );
}

/** Characters the query matched keep the title color; the rest recede. */
function SlashMenuTitle({ title, query }: { title: string; query: string }) {
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

function SlashMenuLoading() {
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
