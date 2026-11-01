import {
  dataSourcePropertyIcon,
  dataSourcePropertyTypeIcon,
} from "@/components/database/data-source-property-presentation";
import { PriorityValueIcon } from "@/components/shared/icons/priority-value-icon";
import { StatusIcon } from "@/lib/status-presentation";
import { cn } from "@/lib/utils";
import type { Priority } from "../../../../shared/types";
import type { DatabaseBoardGroupPresentation } from "./database-board-model";

export function DatabaseBoardGroupMarker({
  group,
  className,
}: {
  readonly group: DatabaseBoardGroupPresentation;
  readonly className?: string;
}) {
  if (group.marker.kind === "status") {
    return (
      <StatusIcon
        statusId={group.marker.statusId}
        className={cn("size-4 shrink-0", className)}
        style={{ color: group.accentColor }}
      />
    );
  }
  if (group.marker.kind === "option") {
    return (
      <span
        aria-hidden="true"
        className={cn("size-2.5 shrink-0 rounded-full", className)}
        style={{ backgroundColor: group.marker.color }}
      />
    );
  }
  if (group.marker.kind === "priority") {
    return (
      <PriorityValueIcon
        priority={group.marker.priorityId as Priority}
        className={className}
        style={{ color: group.accentColor }}
      />
    );
  }
  const Icon =
    group.marker.propertyId === null
      ? dataSourcePropertyTypeIcon(group.marker.valueType)
      : dataSourcePropertyIcon({
          propertyId: group.marker.propertyId,
          valueType: group.marker.valueType,
        });
  return (
    <Icon
      className={cn(
        "size-4 shrink-0",
        group.marker.kind === "unassigned" && "opacity-55",
        className,
      )}
      style={{ color: group.accentColor }}
    />
  );
}
