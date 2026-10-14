import { useId, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const CODEX_SETTINGS_SHELL_STYLE = {
  "--cursor-interaction": "pointer",
} as CSSProperties;

export type NodexSettingsNumberInputProps = Omit<ComponentProps<"input">, "type">;

export function NodexSettingsNumberInput({ className, ...props }: NodexSettingsNumberInputProps) {
  return (
    <input
      {...props}
      type="number"
      data-slot="settings-number-input"
      className={cn(
        "h-token-button-composer rounded-lg border border-token-border bg-token-input-background px-2 py-0 text-right text-sm text-token-text-primary shadow-sm outline-none",
        "focus-visible:ring-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    />
  );
}

export interface NodexCheckboxProps {
  ariaLabel?: string;
  checked: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  onCheckedChange: (checked: boolean) => void;
}

function NodexCheckboxCheckIcon() {
  return (
    <svg aria-hidden="true" className="h-[9px] w-2.5 shrink-0" viewBox="0 0 10 8" fill="none">
      <path
        d="M3.46975 5.70757L1.88358 4.1225C1.65832 3.8974 1.29423 3.8974 1.06897 4.1225C0.843675 4.34765 0.843675 4.7116 1.06897 4.93674L3.0648 6.93117C3.29006 7.15628 3.65414 7.15628 3.8794 6.93117L8.93103 1.88306C9.15633 1.65792 9.15633 1.29397 8.93103 1.06883C8.70578 0.843736 8.34172 0.843724 8.11646 1.06879C8.11645 1.0688 8.11643 1.06882 8.11642 1.06883L3.46975 5.70757Z"
        strokeWidth="0.2"
        fill="currentColor"
      />
    </svg>
  );
}

export function NodexCheckbox({
  ariaLabel,
  checked,
  className,
  disabled = false,
  id,
  onCheckedChange,
}: NodexCheckboxProps) {
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-label={ariaLabel}
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "peer inline-flex items-center justify-center border-token-border bg-transparent",
        "data-[state=checked]:border-transparent data-[state=checked]:bg-(--color-background-primary-solid) data-[state=checked]:text-(--color-text-primary-solid)",
        "focus-visible:border-token-focus-border focus-visible:ring-token-focus-border/30 focus-visible:ring-1",
        "aria-invalid:ring-2 aria-invalid:ring-token-error-foreground/20 aria-invalid:border-token-error-foreground",
        "icon-2xs shrink-0 rounded-[3px] border shadow-none outline-none transition-all duration-[80ms] ease-out",
        "disabled:cursor-not-allowed",
        !disabled && "data-[state=unchecked]:hover:border-token-foreground/40",
        className,
      )}
    >
      {checked ? <NodexCheckboxCheckIcon /> : null}
    </button>
  );
}

export interface NodexSettingsRowProps {
  label: string;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function NodexSettingsRow({
  label,
  description,
  className,
  children,
}: NodexSettingsRowProps) {
  return (
    <div className={cn("flex items-center justify-between gap-6 px-4 py-3", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="min-w-0 text-sm font-medium text-token-text-primary">{label}</div>
          {description ? (
            <div className="min-w-0 break-words text-xs leading-4 text-balance text-token-text-secondary">
              {description}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex max-w-full shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function NodexSettingsSection({
  id,
  title,
  children,
  cardClassName,
}: {
  id?: string;
  title?: string;
  children: ReactNode;
  cardClassName?: string;
}) {
  const titleId = useId();

  return (
    <section id={id} aria-labelledby={title ? titleId : undefined} className="flex flex-col">
      {title ? (
        <h2
          id={titleId}
          className="min-h-toolbar pb-1.5 text-base font-medium text-token-text-primary"
        >
          {title}
        </h2>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <div
          className={cn(
            "flex flex-col overflow-hidden rounded-2xl border border-token-border",
            "[&>*:not(:last-child)]:relative [&>*:not(:last-child)]:after:pointer-events-none",
            "[&>*:not(:last-child)]:after:absolute [&>*:not(:last-child)]:after:inset-x-4",
            "[&>*:not(:last-child)]:after:bottom-0 [&>*:not(:last-child)]:after:h-[0.5px]",
            "[&>*:not(:last-child)]:after:bg-token-border [&>*:not(:last-child)]:after:content-['']",
            cardClassName,
          )}
          style={{ backgroundColor: "var(--color-background-panel, var(--color-token-bg-fog))" }}
        >
          {children}
        </div>
      </div>
    </section>
  );
}

export function NodexSettingsPageSurface({
  title,
  backSlot,
  subtitle,
  children,
  fullWidth = false,
  contentClassName,
  action,
  className,
}: {
  title: string;
  backSlot?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  fullWidth?: boolean;
  contentClassName?: string;
  action?: ReactNode;
  className?: string;
}) {
  const titleId = useId();

  return (
    <main
      aria-labelledby={titleId}
      className={cn("main-surface flex h-full min-h-0 w-full flex-col", className)}
      style={CODEX_SETTINGS_SHELL_STYLE}
    >
      <div className="draggable flex items-center px-panel electron:h-toolbar extension:h-toolbar-sm">
        {backSlot}
      </div>
      <div className="flex-1 overflow-y-auto p-panel">
        <div
          className={cn(
            "mx-auto flex w-full min-w-0 flex-col",
            fullWidth ? null : "max-w-3xl",
            contentClassName,
          )}
        >
          <div className="flex items-center justify-between gap-3 pb-panel">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-panel">
              <h1
                id={titleId}
                className="heading-base break-words electron:text-[length:var(--text-heading-lg)] electron:leading-[1.2]"
              >
                {title}
              </h1>
              {subtitle ? (
                <p className="break-words text-base text-token-text-secondary">{subtitle}</p>
              ) : null}
            </div>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
          <div className="flex flex-col gap-10">{children}</div>
        </div>
      </div>
    </main>
  );
}
