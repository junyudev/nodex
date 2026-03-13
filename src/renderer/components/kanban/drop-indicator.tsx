import { cn } from "@/lib/utils";

export function DropIndicator({ className }: { className?: string }) {
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
    </div>
  );
}
