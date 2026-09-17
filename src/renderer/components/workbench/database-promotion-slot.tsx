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
  const previews = slot.previews.slice(0, slot.count);
  if (compact) {
    return (
      <div
        data-predicted-promotion={slot.operationId}
        aria-hidden="true"
        className={cn(
          "pointer-events-none mx-1.5 h-7 rounded-md bg-token-background-primary",
          className,
        )}
      />
    );
  }
  return (
    <div
      data-predicted-promotion={slot.operationId}
      className={cn("pointer-events-none flex min-w-0 flex-col gap-2", className)}
    >
      {previews.map((preview) => (
        <article
          key={preview.resultPageId ?? preview.rootBlockId}
          data-predicted-page={preview.resultPageId ?? preview.rootBlockId}
          className="min-h-10 min-w-0 overflow-hidden rounded-lg bg-(--card) px-2 py-2 text-base/normal font-medium wrap-break-word text-(--foreground)"
          style={{
            boxShadow:
              "0 4px 12px color-mix(in srgb, var(--foreground) 5%, transparent), 0 1px 2px color-mix(in srgb, var(--foreground) 4%, transparent), 0 0 0 1px color-mix(in srgb, var(--column-accent, var(--foreground-tertiary)) 17%, transparent)",
          }}
        >
          {preview.title || "Untitled"}
        </article>
      ))}
    </div>
  );
};
