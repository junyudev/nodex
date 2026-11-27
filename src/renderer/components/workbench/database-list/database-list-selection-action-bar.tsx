import { useIntl } from "@/lib/i18n";
import {
  ChevronDownIcon,
  CloseIcon,
  PageMenuMoveBottomIcon,
  PageMenuMoveDownIcon,
  PageMenuMoveTopIcon,
  PageMenuMoveUpIcon,
} from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { NodexDropdown } from "@/components/ui/dropdown";
import {
  buildDatabaseListSelectionCommands,
  databaseListMoveDirection,
  type DatabaseListCommandId,
  type DatabaseListMoveDirection,
} from "./database-list-commands";

const reorderIcons = {
  "move-top": PageMenuMoveTopIcon,
  "move-up": PageMenuMoveUpIcon,
  "move-down": PageMenuMoveDownIcon,
  "move-bottom": PageMenuMoveBottomIcon,
} satisfies Record<DatabaseListCommandId, typeof PageMenuMoveTopIcon>;

export function DatabaseListSelectionActionBar({
  count,
  canMoveUp,
  canMoveDown,
  onMove,
  onClear,
}: {
  readonly count: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onMove: (direction: DatabaseListMoveDirection) => void;
  readonly onClear: () => void;
}) {
  const intl = useIntl();
  if (count === 0) return null;
  const commands = buildDatabaseListSelectionCommands({ canMoveUp, canMoveDown }, intl);
  return (
    <div
      role="toolbar"
      aria-label={intl.formatMessage(
        {
          id: "database.databaseListSelectionActionBar.selectedPageActions",
          defaultMessage: "Actions for {count} selected pages",
        },
        { count },
      )}
      className="absolute inset-x-0 bottom-3 z-20 mx-auto flex w-max max-w-[calc(100%-24px)] items-center gap-1 rounded-xl border border-token-border bg-token-dropdown-background/95 px-1.5 py-1 shadow-xl-spread backdrop-blur-md"
    >
      <span className="px-2 text-xs tabular-nums text-token-text-secondary">
        {intl.formatMessage(
          {
            id: "database.databaseListSelectionActionBar.selectedCount",
            defaultMessage: "{count} selected",
          },
          { count },
        )}
      </span>
      <NodexDropdown.Menu
        align="center"
        side="top"
        contentWidth="xs"
        triggerButton={
          <NodexButton
            size="xs"
            variant="ghost"
            aria-label={intl.formatMessage({
              id: "database.databaseListSelectionActionBar.openActions",
              defaultMessage: "Open selected page actions",
            })}
          >
            {intl.formatMessage({
              id: "database.databaseListSelectionActionBar.actions",
              defaultMessage: "Actions",
            })}
            <ChevronDownIcon className="icon-2xs" />
          </NodexButton>
        }
      >
        {commands.map((command) => {
          const Icon = reorderIcons[command.id];
          return (
            <NodexDropdown.Item
              key={command.id}
              disabled={command.disabled}
              leftSlot={<Icon />}
              onSelect={() => {
                const direction = databaseListMoveDirection(command.id);
                if (direction) onMove(direction);
              }}
            >
              {command.label}
            </NodexDropdown.Item>
          );
        })}
      </NodexDropdown.Menu>
      <NodexIconButton
        icon={CloseIcon}
        size="xs"
        ariaLabel={intl.formatMessage({
          id: "database.databaseListSelectionActionBar.clearSelection",
          defaultMessage: "Clear selection",
        })}
        onClick={onClear}
      />
    </div>
  );
}
