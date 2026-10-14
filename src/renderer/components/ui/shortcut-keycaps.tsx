import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export interface ShortcutKeycapsProps extends Omit<ComponentPropsWithoutRef<"kbd">, "children"> {
  readonly keys: readonly string[];
  readonly density?: "compact" | "default" | "settings";
  readonly tone?: "muted" | "current";
}

const densityClassNames = {
  compact: "h-[18px] min-w-[18px] px-1 text-xs",
  default: "h-5 min-w-5 px-1.5 text-xs",
  settings: "h-7 min-w-7 px-2 text-sm",
} as const;

export function ShortcutKeycaps({
  keys,
  density = "default",
  tone = "muted",
  className,
  ...props
}: ShortcutKeycapsProps) {
  return (
    <kbd
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[4px] border-0 font-sans leading-none font-medium tracking-wide shadow-none tabular-nums",
        densityClassNames[density],
        tone === "current"
          ? "bg-current/10 text-current"
          : "bg-token-foreground/5 text-token-description-foreground",
        className,
      )}
      {...props}
    >
      {keys.join("")}
    </kbd>
  );
}

export function ShortcutKeycapSequence({
  chords,
  density = "default",
  tone = "muted",
  className,
}: {
  readonly chords: readonly string[];
  readonly density?: ShortcutKeycapsProps["density"];
  readonly tone?: ShortcutKeycapsProps["tone"];
  readonly className?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {chords.map((chord, index) => (
        <span key={`${chord}-${index}`} className="inline-flex items-center gap-1">
          {index > 0 ? (
            <span className="text-xs font-medium text-token-description-foreground">then</span>
          ) : null}
          <ShortcutKeycaps keys={[chord]} density={density} tone={tone} />
        </span>
      ))}
    </span>
  );
}
