import { cn } from "@/lib/utils";

export function DropIndicator({
  className,
  label,
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn("pointer-events-none z-10 h-0.5", className)}>
      {/* Circle on left edge */}
      <div
        className="absolute top-1/2 left-0 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
        style={{ backgroundColor: "var(--column-accent)" }}
      />
      {/* Line */}
      <div
        className="ml-0.75 h-full rounded-full"
        style={{ backgroundColor: "var(--column-accent)" }}
      />
      {label ? (
        <div className="absolute top-0 left-3 rounded-sm bg-(--background) px-1.5 py-0.5 text-[10px]/none font-medium text-(--foreground-secondary) shadow-[0_0_0_1px_color-mix(in_srgb,var(--column-accent)_28%,transparent)]">
          {label}
        </div>
      ) : null}
    </div>
  );
}
