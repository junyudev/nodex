import { PlusIcon } from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownSelectedIcon } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import type { CommandPaletteCommand } from "@/lib/command-palette";
import {
  spaceAvailabilityLabel,
  type SpaceAvailability,
  type SpaceConnectionSummary,
} from "../../../shared/space-connection";
import { SpaceAvatar } from "./space-avatar";
import { switchSpace, useSpaces } from "./spaces-runtime";

/** The dot a Space's face carries while its host cannot be used as usual. */
export const SPACE_AVAILABILITY_DOT: Record<Exclude<SpaceAvailability, "ready">, string> = {
  reconnecting: "bg-token-charts-orange",
  unavailable: "bg-token-charts-red",
  "access-revoked": "bg-token-charts-red",
};

/** Opens another Space in this window; a refusal leaves the window where it is and says why. */
function openSpace(spaceId: string): void {
  void switchSpace(spaceId).catch((error: unknown) =>
    toast.danger(error instanceof Error ? error.message : "Could not switch Spaces"),
  );
}

/**
 * A menu's Spaces block: every connected Space, this window's checked, once there is another to
 * choose, then Join a Space. Joining opens a dialog, so the menu records the request and opens it
 * after closing.
 */
export function SpaceMenuItems({
  spaces,
  current,
  onJoin,
}: {
  readonly spaces: readonly SpaceConnectionSummary[];
  readonly current: SpaceConnectionSummary;
  readonly onJoin: () => void;
}) {
  return (
    <>
      {spaces.length > 1
        ? spaces.map((space) => {
            const selected = space.spaceId === current.spaceId;
            return (
              <NodexDropdownItem
                key={space.spaceId}
                aria-current={selected || undefined}
                leftSlot={<SpaceAvatar space={space} size="menu" />}
                rightSlot={selected ? <NodexDropdownSelectedIcon /> : null}
                subText={
                  space.availability === "ready"
                    ? undefined
                    : spaceAvailabilityLabel(space.availability)
                }
                onSelect={() => openSpace(space.spaceId)}
              >
                {space.name}
              </NodexDropdownItem>
            );
          })
        : null}
      <NodexDropdownItem
        leftSlot={
          <span className="inline-flex size-5 items-center justify-center">
            <PlusIcon />
          </span>
        }
        onSelect={onJoin}
      >
        Join a Space
      </NodexDropdownItem>
    </>
  );
}

const SWITCH_COMMAND_PREFIX = "space:switch:";

export const isSpaceSwitchCommandId = (commandId: string): boolean =>
  commandId.startsWith(SWITCH_COMMAND_PREFIX);

export interface SpaceSwitchCommands {
  readonly commands: readonly CommandPaletteCommand[];
  /** Runs a listed command and reports whether the id was one. */
  readonly execute: (commandId: string) => boolean;
}

/** Command palette Navigation entries that open each Space other than this window's. */
export function useSpaceSwitchCommands(): SpaceSwitchCommands {
  const { spaces, current } = useSpaces();
  return {
    commands: spaces
      .filter((space) => space.spaceId !== current.spaceId)
      .map((space, index): CommandPaletteCommand => ({
        kind: "command",
        id: `${SWITCH_COMMAND_PREFIX}${space.spaceId}`,
        title: `Switch to ${space.name}`,
        subtitle: "",
        keywords: ["space", "switch", "open", space.kind],
        group: "Navigation",
        priority: 990 - index,
      })),
    execute: (commandId) => {
      if (!isSpaceSwitchCommandId(commandId)) return false;
      openSpace(commandId.slice(SWITCH_COMMAND_PREFIX.length));
      return true;
    },
  };
}
