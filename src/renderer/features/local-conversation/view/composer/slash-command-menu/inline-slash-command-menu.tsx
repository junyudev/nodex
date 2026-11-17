import type {
  ComposerSlashCommand,
  ComposerSlashCommandGroup,
  ComposerSlashHighlightSource,
  ComposerSlashSubmenuItem,
  ComposerSlashSubmenuSectionView,
} from "./slash-command-types";
import { SlashCommandList, SlashSubmenuList } from "./slash-command-list";
import { ComposerSuggestionSurface } from "../composer-suggestion-surface";

export type InlineSlashCommandMenuView =
  | {
      readonly kind: "commands";
      readonly groups: readonly ComposerSlashCommandGroup[];
      readonly loading: boolean;
    }
  | {
      readonly kind: "submenu";
      readonly command: ComposerSlashCommand;
      readonly title: string;
      readonly sections: readonly ComposerSlashSubmenuSectionView[];
    };

/**
 * The slash menu above the Composer. A command with choices replaces the list with them while
 * the slash stays in the draft; Backspace on an empty query returns to the commands.
 */
export function InlineSlashCommandMenu({
  view,
  query,
  isHomeMenu = false,
  highlightedRowId,
  highlightSource,
  onHighlight,
  onSelectCommand,
  onSelectItem,
}: {
  view: InlineSlashCommandMenuView | null;
  query: string;
  isHomeMenu?: boolean;
  highlightedRowId: string | null;
  highlightSource: ComposerSlashHighlightSource;
  onHighlight: (rowId: string, source: ComposerSlashHighlightSource) => void;
  onSelectCommand: (command: ComposerSlashCommand) => void;
  onSelectItem: (item: ComposerSlashSubmenuItem) => void;
}) {
  if (!view) return null;
  const highlight = { rowId: highlightedRowId, source: highlightSource, onHighlight };
  return (
    <ComposerSuggestionSurface
      kind="slash-command"
      isHomeMenu={isHomeMenu}
      {...(view.kind === "submenu" ? { ariaLabel: view.title } : {})}
    >
      {view.kind === "submenu" ? (
        <SlashSubmenuList
          sections={view.sections}
          query={query}
          icon={view.command.icon}
          highlight={highlight}
          onSelect={onSelectItem}
        />
      ) : (
        <SlashCommandList
          groups={view.groups}
          query={query}
          loading={view.loading}
          highlight={highlight}
          onSelect={onSelectCommand}
        />
      )}
    </ComposerSuggestionSurface>
  );
}
