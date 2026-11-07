import type { ReactNode } from "react";
import { ArrowRightIcon } from "@/components/shared/icons/plugin-detail-icons";
import { NodexButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function FirstRunTitle({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <header className="text-center">
      <h1 className="text-[26px] leading-8 font-semibold tracking-tight text-token-text-primary">
        {title}
      </h1>
      <p className="mt-2 text-base text-token-text-secondary">{description}</p>
    </header>
  );
}

export function FirstRunCard({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "mt-6 divide-y-[0.5px] divide-token-border overflow-hidden rounded-xl border-[0.5px] border-token-border bg-token-bg-fog text-left",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FirstRunRow({
  leading,
  label,
  detail,
  trailing,
}: {
  readonly leading?: ReactNode;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-3.5 py-2.5">
      {leading}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-token-text-primary">{label}</div>
        {detail ? (
          <div className="truncate text-xs text-token-description-foreground">{detail}</div>
        ) : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
    </div>
  );
}

/** A row that is itself the action, so it needs no button repeating its label. */
export function FirstRunActionRow({
  icon,
  label,
  disabled,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left text-sm text-token-text-primary not-disabled:hover:bg-token-foreground/5 disabled:opacity-50"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The one action a step asks for; Enter presses it as soon as the step appears. A quiet one is a way
 * past the step rather than what it asks for, so it neither stands out nor takes the Enter key.
 */
export function FirstRunPrimary({
  children,
  disabled,
  onClick,
  quiet,
  secondary,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly quiet?: boolean;
  readonly secondary?: ReactNode;
}) {
  return (
    <div className="mt-6 flex items-center justify-center gap-2">
      {secondary}
      {/* Keyed so that the action takes Enter the moment it stops being quiet. */}
      <NodexButton
        key={quiet ? "quiet" : "primary"}
        autoFocus={!quiet}
        disabled={disabled}
        variant={quiet ? "ghostSecondary" : undefined}
        onClick={onClick}
      >
        {children}
        <ArrowRightIcon className="icon-2xs" />
      </NodexButton>
    </div>
  );
}
