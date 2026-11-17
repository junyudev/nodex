import { useIntl } from "@/lib/i18n";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandGroup,
  ComposerSlashCommandHighlightSource,
} from "./slash-command-types";
import { SlashCommandList } from "./slash-command-list";
import { ComposerSuggestionSurface } from "../composer-suggestion-surface";

interface InlineSlashCommandMenuProps {
  open: boolean;
  isHomeMenu?: boolean;
  groups: readonly ComposerSlashCommandGroup[];
  query: string;
  loading: boolean;
  highlightedCommandId: string | null;
  highlightedSource: ComposerSlashCommandHighlightSource;
  nestedCommand: ComposerSlashCommand | null;
  onHighlight: (commandId: string, source: ComposerSlashCommandHighlightSource) => void;
  onSelect: (command: ComposerSlashCommand) => void;
  onClose: () => void;
  onBack: () => void;
}

export function InlineSlashCommandMenu({
  open,
  isHomeMenu = false,
  groups,
  query,
  loading,
  highlightedCommandId,
  highlightedSource,
  nestedCommand,
  onHighlight,
  onSelect,
  onClose,
  onBack,
}: InlineSlashCommandMenuProps) {
  const intl = useIntl();
  if (!open) return null;

  return (
    <ComposerSuggestionSurface kind="slash-command" isHomeMenu={isHomeMenu}>
      {nestedCommand?.Content ? (
        <div className="flex min-h-0 flex-col">
          <div className="flex h-[30px] shrink-0 items-center gap-2 rounded-lg px-row-x py-row-y text-sm">
            <button
              type="button"
              className="text-token-foreground outline-hidden opacity-75 focus:bg-token-list-hover-background cursor-interaction shrink-0 overflow-hidden rounded-lg px-row-x py-row-y text-left text-sm hover:bg-token-list-hover-background hover:opacity-100"
              onClick={onBack}
            >
              {intl.formatMessage({
                id: "conversation.inlineSlashCommandMenu.back",
                defaultMessage: "Back",
              })}
            </button>
            <span className="min-w-0 truncate">
              {nestedCommand.titleMessage
                ? intl.formatMessage(nestedCommand.titleMessage)
                : nestedCommand.title}
            </span>
          </div>
          <div className="vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto">
            <nestedCommand.Content close={onClose} back={onBack} />
          </div>
        </div>
      ) : (
        <SlashCommandList
          groups={groups}
          query={query}
          loading={loading}
          highlightedCommandId={highlightedCommandId}
          highlightedSource={highlightedSource}
          onHighlight={onHighlight}
          onSelect={onSelect}
        />
      )}
    </ComposerSuggestionSurface>
  );
}
