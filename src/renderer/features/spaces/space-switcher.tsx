import { toast } from "@/components/ui/toast";
import { useState } from "react";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownRoot,
  NodexDropdownTrigger,
  NodexDropdownPortal,
  NodexDropdownContent,
  NodexDropdownItem,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { spaceAvailabilityLabel, type SpaceAvailability } from "../../../shared/space-connection";
import { currentSpace, switchSpace, useSpaceConnections } from "./spaces-runtime";
import { useOpenJoinSpace } from "./join-space-dialog";
import { SpaceAvatar } from "./space-avatar";

const AVAILABILITY_DOT: Record<Exclude<SpaceAvailability, "ready">, string> = {
  reconnecting: "bg-token-charts-orange",
  unavailable: "bg-token-charts-red",
  "access-revoked": "bg-token-charts-red",
};

export function SpaceSwitcher() {
  const spaces = useSpaceConnections();
  const bound = currentSpace();
  const list = spaces.data ?? [bound];
  const active = list.find((space) => space.spaceId === bound.spaceId) ?? bound;
  const openJoin = useOpenJoinSpace();
  const [joinPending, setJoinPending] = useState(false);
  const status =
    active.availability === "ready" ? null : spaceAvailabilityLabel(active.availability);
  return (
    <NodexDropdownRoot>
      <NodexTooltip
        tooltipContent={status ? `${active.name} · ${status}` : active.name}
        side="right"
      >
        <NodexDropdownTrigger nativeButton>
          <NodexButton
            variant="ghostSecondary"
            size="icon"
            aria-label="Switch Space"
            className="no-drag relative rounded-lg"
          >
            <SpaceAvatar space={active} size="rail" />
            {active.availability === "ready" ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute right-0.5 bottom-0.5 size-2.5 rounded-full ring-2 ring-token-side-bar-background",
                  AVAILABILITY_DOT[active.availability],
                )}
              />
            )}
          </NodexButton>
        </NodexDropdownTrigger>
      </NodexTooltip>
      <NodexDropdownPortal>
        <NodexDropdownContent
          side="right"
          align="start"
          finalFocus={() => {
            if (!joinPending) return;
            setJoinPending(false);
            openJoin();
          }}
        >
          {list.map((space) => (
            <NodexDropdownItem
              key={space.spaceId}
              leftSlot={<SpaceAvatar space={space} size="menu" />}
              rightSlot={space.spaceId === active.spaceId ? <NodexDropdownSelectedIcon /> : null}
              subText={
                space.availability === "ready"
                  ? undefined
                  : spaceAvailabilityLabel(space.availability)
              }
              onSelect={() => {
                void switchSpace(space.spaceId).catch((error: unknown) =>
                  toast.danger(error instanceof Error ? error.message : "Could not switch Spaces"),
                );
              }}
            >
              {space.name}
            </NodexDropdownItem>
          ))}
          <NodexDropdownSeparator />
          <NodexDropdownItem onSelect={() => setJoinPending(true)}>Join a Space…</NodexDropdownItem>
        </NodexDropdownContent>
      </NodexDropdownPortal>
    </NodexDropdownRoot>
  );
}
