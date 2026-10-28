import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Pins the shared conversation fade to the pane, outside its scrolling content. */
export function ConversationContentFrame({
  children,
  className,
  topFade,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly topFade: boolean;
}) {
  return (
    <div className={cn("relative min-h-0", className)}>
      <div
        aria-hidden="true"
        data-app-shell-main-content-top-fade={topFade ? "visible" : "hidden"}
        className="app-shell-main-content-top-fade pointer-events-none absolute inset-x-0 top-0 z-20 h-10 opacity-0 transition-opacity duration-200 browser:hidden"
      />
      {children}
    </div>
  );
}
