import { cn } from "@/lib/utils";

interface CardStageRawContentProps {
  content: string;
  className?: string;
}

export function CardStageRawContent({
  content,
  className,
}: CardStageRawContentProps) {
  const hasContent = content.length > 0;

  return (
    <section
      aria-label="Raw card content"
      className={cn(
        "overflow-hidden rounded-xl border border-(--border) bg-foreground-2",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-(--border) px-3 py-2">
        <div className="text-xs font-medium tracking-wide text-(--foreground-secondary) uppercase">
          Raw format
        </div>
        <div className="text-[11px] text-(--foreground-tertiary)">
          Read-only
        </div>
      </div>

      {hasContent ? (
        <pre className="overflow-x-auto px-3 py-3 font-mono text-[12px]/5 text-(--foreground)">
          {content}
        </pre>
      ) : (
        <div className="px-3 py-4 font-mono text-[12px]/5 text-(--foreground-tertiary)">
          Description is empty.
        </div>
      )}
    </section>
  );
}
