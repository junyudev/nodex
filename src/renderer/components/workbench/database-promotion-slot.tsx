import type { DatabasePromotionSlot as Slot } from "@/lib/database-promotion-presentation";
import { cn } from "@/lib/utils";

export const DatabasePromotionSlot = ({
  slot,
  compact = false,
  className,
}: {
  readonly slot: Slot;
  readonly compact?: boolean;
  readonly className?: string;
}) => {
  const label = `${slot.mode === "copy" ? "Copying" : "Moving"} ${slot.count === 1 ? "block" : `${slot.count} blocks`}…`;
  return (
    <div
      role="status"
      aria-label={label}
      data-pending-promotion={slot.operationId}
      className={cn(
        "pointer-events-none flex min-h-8 items-center gap-2 px-2.5 text-xs text-token-text-secondary",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none"
      />
      {!compact && <span className="truncate">{label}</span>}
    </div>
  );
};
