import type { ReactNode } from "react";

import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Window-level status pills share the bottom edge and stack, so concurrent conditions stay legible. */
export function AppStatusNoticeStack({ children }: { readonly children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-3 z-[61] flex flex-col items-center gap-2">
      {children}
    </div>
  );
}

export function AppStatusNotice({
  actions,
  detail,
  icon,
  label,
  urgent = false,
}: {
  readonly actions?: ReactNode;
  readonly detail?: string | null;
  readonly icon: ReactNode;
  readonly label: string;
  readonly urgent?: boolean;
}) {
  return (
    <div
      aria-live={urgent ? "assertive" : "polite"}
      className="pointer-events-auto flex max-w-[min(42rem,calc(100vw-1.5rem))] items-center gap-2 rounded-xl bg-token-dropdown-background/90 px-2.5 py-1.5 text-xs text-token-foreground shadow-lg ring-[0.5px] ring-token-border backdrop-blur-sm"
      role={urgent ? "alert" : "status"}
    >
      {icon}
      <span className="shrink-0 font-medium">{label}</span>
      {detail ? <span className="truncate text-token-description-foreground">{detail}</span> : null}
      {actions ? <div className="ml-1 flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </div>
  );
}

export function AppStatusNoticeAction({
  children,
  disabled = false,
  onClick,
  subdued = false,
  tooltip,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly subdued?: boolean;
  readonly tooltip?: string;
}) {
  const button = (
    <button
      className={cn(
        "rounded-lg px-2 py-1 disabled:opacity-50",
        subdued
          ? "text-token-description-foreground enabled:hover:bg-token-foreground/5 enabled:hover:text-token-foreground"
          : "font-medium enabled:hover:bg-token-foreground/10",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
  return tooltip ? (
    <NodexTooltip side="top" tooltipContent={tooltip}>
      {button}
    </NodexTooltip>
  ) : (
    button
  );
}
