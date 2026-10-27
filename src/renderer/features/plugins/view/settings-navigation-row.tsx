import type { ReactNode } from "react";
import { ChevronRightMdIcon } from "@/components/shared/icons/customize-action-icons";

/**
 * A settings list row that opens something: its icon, label and description, controls that
 * stay clickable on their own, and a trailing chevron.
 */
export function SettingsNavigationRow({
  icon,
  label,
  description,
  actions,
  ariaLabel,
  onOpen,
}: {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly ariaLabel?: string;
  readonly onOpen: () => void;
}) {
  return (
    <div className="group grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 focus-within:bg-token-list-hover-background hover:bg-token-list-hover-background">
      <button
        type="button"
        aria-label={ariaLabel}
        className="col-span-full row-start-1 grid min-w-0 flex-1 cursor-interaction grid-cols-subgrid items-center gap-2 rounded-[inherit] px-4 py-3 text-start focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-token-focus-border"
        onClick={onOpen}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex shrink-0">{icon}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="min-w-0 text-sm font-medium break-words text-token-foreground">
              {label}
            </div>
            {description ? (
              <div className="min-w-0 text-xs leading-4 text-wrap break-words text-(--color-text-secondary)">
                {description}
              </div>
            ) : null}
          </div>
        </div>
        <div className="col-start-3 flex shrink-0 items-center gap-2">
          <ChevronRightMdIcon className="text-tertiary" />
        </div>
      </button>
      {actions == null ? null : (
        <div className="relative col-start-2 row-start-1 flex shrink-0 items-center gap-1">
          {actions}
        </div>
      )}
    </div>
  );
}

/** A settings row's 36px logo tile. */
export function SettingsRowLogo({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface)">
      {children}
    </span>
  );
}
