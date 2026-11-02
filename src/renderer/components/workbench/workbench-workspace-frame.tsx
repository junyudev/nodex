import type { ReactNode, RefCallback } from "react";

/** The rail and sidebar fill the workspace; only the content column clears its header. */
export function WorkbenchWorkspaceFrame({
  rail,
  children,
  bodyRef,
  summaryLayout,
  widthClass,
}: {
  readonly rail: ReactNode;
  readonly children: ReactNode;
  readonly bodyRef?: RefCallback<HTMLElement>;
  readonly summaryLayout?: string;
  readonly widthClass?: string;
}) {
  return (
    <div
      data-workbench-workspace-row
      className="relative flex min-h-0 min-w-0 flex-1 pt-(--app-shell-workspace-top-inset)"
    >
      <div
        aria-hidden="true"
        data-app-shell-page-surface-shadow
        className="pointer-events-none absolute top-(--app-shell-surface-top-inset) right-1 bottom-1 left-(--app-shell-navigation-rail-width) rounded-(--app-shell-surface-radius) shadow-[var(--app-shell-page-surface-shadow)]"
      />
      <div className="shrink-0 pb-1">{rail}</div>
      <div className="relative flex min-h-0 min-w-0 flex-1 pr-1 pb-1">
        <div
          ref={bodyRef}
          data-app-shell-summary-layout={summaryLayout}
          data-app-shell-width-class={widthClass}
          className="relative flex max-h-full min-h-0 min-w-0 flex-1"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
