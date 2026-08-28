import { ChevronDownIcon, CloseIcon } from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { NodexDropdown } from "@/components/ui/dropdown";
import {
  buildDatabaseListSelectionCommands,
  databaseListMoveDirection,
  type DatabaseListMoveDirection,
} from "./database-list-commands";

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
  if (count === 0) return null;
  const commands = buildDatabaseListSelectionCommands({ canMoveUp, canMoveDown });
  return (
    <div
      role="toolbar"
      aria-label={`Actions for ${count} selected pages`}
      className="absolute inset-x-0 bottom-3 z-20 mx-auto flex w-max max-w-[calc(100%-24px)] items-center gap-1 rounded-xl border border-token-border bg-token-dropdown-background/95 px-1.5 py-1 shadow-xl-spread backdrop-blur-md"
    >
      <span className="px-2 text-xs tabular-nums text-token-text-secondary">{count} selected</span>
      <NodexDropdown.Menu
        align="center"
        side="top"
        contentWidth="xs"
        triggerButton={
          <NodexButton size="xs" variant="ghost" aria-label="Open selected page actions">
            Actions
            <ChevronDownIcon className="icon-2xs" />
          </NodexButton>
        }
      >
        {commands.map((command) => (
          <NodexDropdown.Item
            key={command.id}
            disabled={command.disabled}
            onSelect={() => {
              const direction = databaseListMoveDirection(command.id);
              if (direction) onMove(direction);
            }}
          >
            {command.label}
          </NodexDropdown.Item>
        ))}
      </NodexDropdown.Menu>
      <NodexIconButton icon={CloseIcon} size="xs" ariaLabel="Clear selection" onClick={onClear} />
    </div>
  );
}
