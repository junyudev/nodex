import { useMemo, useState } from "react";
import {
  filterComposerSlashCommands,
  groupComposerSlashCommandMatches,
  resolveComposerSlashHighlight,
} from "./slash-command-filter";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandHighlightIntent,
} from "./slash-command-types";
import { SlashCommandList } from "./slash-command-list";

interface ExpandedSlashCommandDialogProps {
  commands: readonly ComposerSlashCommand[];
  composerText: string;
  onSelect: (command: ComposerSlashCommand) => void;
  onClose: () => void;
}

export function ExpandedSlashCommandDialog({
  commands,
  composerText,
  onSelect,
  onClose,
}: ExpandedSlashCommandDialogProps) {
  const [query, setQuery] = useState("");
  const [nestedCommand, setNestedCommand] = useState<ComposerSlashCommand | null>(null);
  const [highlightIntent, setHighlightIntent] = useState<ComposerSlashCommandHighlightIntent>({
    commandId: null,
    source: "programmatic",
  });
  const matches = useMemo(
    () => filterComposerSlashCommands({ commands, query, composerText }),
    [commands, composerText, query],
  );
  const groups = useMemo(() => groupComposerSlashCommandMatches(matches), [matches]);
  const resolvedHighlight = resolveComposerSlashHighlight({
    matches,
    intent: highlightIntent,
  });

  const handleSelect = (command: ComposerSlashCommand) => {
    if (command.Content) {
      setNestedCommand(command);
      return;
    }
    onSelect(command);
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-50 bg-transparent" role="presentation">
      <div
        data-composer-overlay-floating-ui="true"
        className="pointer-events-auto absolute bottom-8 left-1/2 w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2"
      >
        <div
          data-slash-command-menu="true"
          className="border-token-border bg-token-dropdown-background/90 relative flex max-h-[420px] w-full min-h-0 flex-col overflow-hidden rounded-2xl border p-1 text-sm font-[445] text-token-foreground backdrop-blur-sm"
          role="dialog"
          aria-label="Slash command menu"
        >
          {nestedCommand?.Content ? (
            <>
              <div className="flex h-[30px] shrink-0 items-center gap-2 rounded-lg px-row-x py-row-y text-sm">
                <button
                  type="button"
                  className="text-token-foreground outline-hidden opacity-75 focus:bg-token-list-hover-background cursor-interaction shrink-0 overflow-hidden rounded-lg px-row-x py-row-y text-left text-sm hover:bg-token-list-hover-background hover:opacity-100"
                  onClick={() => setNestedCommand(null)}
                >
                  Back
                </button>
                <span className="min-w-0 truncate">{nestedCommand.title}</span>
              </div>
              <div className="vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto">
                <nestedCommand.Content close={onClose} back={() => setNestedCommand(null)} />
              </div>
            </>
          ) : (
            <>
              <label
                className="flex h-[30px] shrink-0 items-center rounded-lg px-row-x py-row-y text-sm"
                aria-label="Search and run slash commands"
              >
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-sm text-token-foreground outline-hidden placeholder:text-token-description-foreground"
                  placeholder="Search"
                  aria-label="Search"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onClose();
                    }
                  }}
                />
              </label>
              <SlashCommandList
                groups={groups}
                matches={matches}
                highlightedCommandId={resolvedHighlight.commandId}
                highlightedSource={resolvedHighlight.source}
                onHighlight={(commandId, source) => setHighlightIntent({ commandId, source })}
                onSelect={handleSelect}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
