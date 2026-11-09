import { currentSpace, useSpaceConnections } from "./spaces-runtime";
import { spaceAvailabilityLabel } from "../../../shared/space-connection";

export function SpaceAvailabilityNotice() {
  const connections = useSpaceConnections();
  const binding = currentSpace();
  const current = connections.data?.find((entry) => entry.spaceId === binding.spaceId) ?? binding;
  if (current.kind !== "team" || current.availability === "ready") return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-3 bottom-4 z-50 flex justify-center"
    >
      <p className="rounded-lg bg-token-main-surface-primary px-3 py-2 text-sm shadow-sm ring-[0.5px] ring-token-border">
        {spaceAvailabilityLabel(current.availability)}
      </p>
    </div>
  );
}
