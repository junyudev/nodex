import { useMemo } from "react";
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useBlockNoteEditor,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { Link2, ListTree } from "lucide-react";
import { getDefaultToggleListInlineViewProps } from "@/lib/toggle-list/inline-view-props";
import { useAllBoards } from "@/lib/use-all-boards";

interface NfmSlashMenuProps {
  projectId: string;
}

type UnsafeEditor = Parameters<typeof insertOrUpdateBlockForSlashMenu>[0];
type UnsafeBlock = Parameters<typeof insertOrUpdateBlockForSlashMenu>[1];

function insertBlock(editor: unknown, block: Record<string, unknown>) {
  insertOrUpdateBlockForSlashMenu(editor as UnsafeEditor, block as UnsafeBlock);
}

export function NfmSlashMenu({ projectId }: NfmSlashMenuProps) {
  const editor = useBlockNoteEditor();

  const getItems = useMemo(
    () => async (query: string) => {
      const defaults = getDefaultReactSlashMenuItems(editor);

      const toggleListItem = {
        key: "toggle_list_inline_view",
        title: "Toggle List Inline View",
        subtext: "Embed a project's toggle-list section",
        aliases: ["toggle-list", "project view", "inline toggle"],
        group: "Other",
        icon: <ListTree size={18} />,
        onItemClick: () => {
          insertBlock(editor, {
            type: "toggleListInlineView",
            props: getDefaultToggleListInlineViewProps(projectId || "default"),
          });
        },
      };

      const cardRefItem = {
        key: "card_reference",
        title: "Card Reference",
        subtext: "Embed a single card with inline editing",
        aliases: ["card", "card-reference", "card ref", "card-ref", "embed card"],
        group: "Other",
        icon: <Link2 size={18} />,
        onItemClick: () => {
          insertBlock(editor, {
            type: "cardRef",
            props: { sourceProjectId: projectId || "default", cardId: "" },
          });
        },
      };

      return filterSuggestionItems([...defaults, toggleListItem, cardRefItem], query);
    },
    [editor, projectId],
  );

  return (
    <>
      <SuggestionMenuController
        triggerCharacter="/"
        getItems={getItems}
      />
      <CardMentionMenu projectId={projectId} />
    </>
  );
}

// ---------------------------------------------------------------------------
// @ mention for card references
// ---------------------------------------------------------------------------

function CardMentionMenu({ projectId }: { projectId: string }) {
  const editor = useBlockNoteEditor();
  const { boards } = useAllBoards();

  const getItems = useMemo(
    () => async (query: string) => {
      const items: DefaultReactSuggestionItem[] = [];

      // Current project first, then others
      const sortedEntries = [...boards.entries()].sort(([a], [b]) => {
        if (a === projectId) return -1;
        if (b === projectId) return 1;
        return 0;
      });

      for (const [projId, board] of sortedEntries) {
        for (const column of board.columns) {
          for (const card of column.cards) {
            items.push({
              title: card.title || "Untitled",
              subtext: `${projId} / ${column.name}`,
              aliases: [],
              group: projId,
              icon: <Link2 size={18} />,
              onItemClick: () => {
                insertBlock(editor, {
                  type: "cardRef",
                  props: { sourceProjectId: projId, cardId: card.id },
                });
              },
            });
          }
        }
      }

      return filterSuggestionItems(items, query);
    },
    [boards, editor, projectId],
  );

  return (
    <SuggestionMenuController
      triggerCharacter="@"
      getItems={getItems}
    />
  );
}
