import { useIntl } from "@/lib/i18n";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { ComposerSuggestionRow } from "../composer-suggestion-surface";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandGroup,
  ComposerSlashCommandHighlightSource,
  ComposerSlashCommandMatch,
} from "./slash-command-types";

interface SlashCommandListProps {
  groups: ComposerSlashCommandGroup[];
  matches: readonly ComposerSlashCommandMatch[];
  highlightedCommandId: string | null;
  highlightedSource: ComposerSlashCommandHighlightSource;
  onHighlight: (commandId: string, source: ComposerSlashCommandHighlightSource) => void;
  onSelect: (command: ComposerSlashCommand) => void;
}

export function SlashCommandList({
  groups,
  matches,
  highlightedCommandId,
  highlightedSource,
  onHighlight,
  onSelect,
}: SlashCommandListProps) {
  const intl = useIntl();
  if (matches.length === 0) {
    return (
      <div className="px-row-x py-row-y text-sm text-token-input-placeholder-foreground">
        {intl.formatMessage({
          id: "conversation.slashCommandList.empty",
          defaultMessage: "No commands",
        })}
      </div>
    );
  }

  const showGroupLabels = groups.length > 1;

  return (
    <div
      className={cn(
        "vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto",
        showGroupLabels && "scroll-pt-7",
      )}
    >
      {groups.map((group) => (
        <SlashCommandGroup
          key={group.id}
          group={group}
          showLabel={showGroupLabels}
          highlightedCommandId={highlightedCommandId}
          highlightedSource={highlightedSource}
          onHighlight={onHighlight}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function SlashCommandGroup({
  group,
  showLabel,
  highlightedCommandId,
  highlightedSource,
  onHighlight,
  onSelect,
}: {
  group: ComposerSlashCommandGroup;
  showLabel: boolean;
  highlightedCommandId: string | null;
  highlightedSource: ComposerSlashCommandHighlightSource;
  onHighlight: (commandId: string, source: ComposerSlashCommandHighlightSource) => void;
  onSelect: (command: ComposerSlashCommand) => void;
}) {
  const intl = useIntl();
  return (
    <div className="flex flex-col">
      {showLabel ? (
        <div className="text-token-description-foreground sticky top-0 z-10 bg-token-dropdown-background/95 px-row-x py-1 pt-2 text-sm backdrop-blur-sm">
          {group.label === "Commands"
            ? intl.formatMessage({
                id: "conversation.slashCommandList.commands",
                defaultMessage: "Commands",
              })
            : group.label}
        </div>
      ) : null}
      {group.commands.map((command) => (
        <SlashCommandRow
          key={command.id}
          command={command}
          selected={command.id === highlightedCommandId}
          shouldScrollIntoView={highlightedSource !== "pointer"}
          onHighlight={onHighlight}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function SlashCommandRow({
  command,
  selected,
  shouldScrollIntoView,
  onHighlight,
  onSelect,
}: {
  command: ComposerSlashCommand;
  selected: boolean;
  shouldScrollIntoView: boolean;
  onHighlight: (commandId: string, source: ComposerSlashCommandHighlightSource) => void;
  onSelect: (command: ComposerSlashCommand) => void;
}) {
  const intl = useIntl();
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
      <div className="flex w-full items-center gap-2">
        {command.icon}
        <div
          className={cn(command.description ? "flex-shrink-0 truncate" : "min-w-0 flex-1 truncate")}
        >
          {command.titleMessage ? intl.formatMessage(command.titleMessage) : command.title}
        </div>
        {command.description ? (
          <span className="min-w-0 flex-1 truncate text-sm text-token-description-foreground">
            {command.description}
          </span>
        ) : null}
      </div>
    </ComposerSuggestionRow>
  );
}
