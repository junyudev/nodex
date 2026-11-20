import type { ReactNode, Ref } from "react";
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

/** Rows parted by hairlines inset from the card's edges. */
const rowHairlines =
  "[&>*:not(:last-child)]:relative [&>*:not(:last-child)]:after:pointer-events-none [&>*:not(:last-child)]:after:absolute [&>*:not(:last-child)]:after:inset-x-3.5 [&>*:not(:last-child)]:after:bottom-0 [&>*:not(:last-child)]:after:h-[0.5px] [&>*:not(:last-child)]:after:bg-token-border [&>*:not(:last-child)]:after:content-['']";

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
        // A raised sheet on the page.
        "mt-6 overflow-hidden rounded-2xl border-[0.5px] border-token-border bg-token-dropdown-background text-left",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)]",
        rowHairlines,
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Rows that scroll inside a card while the rows around them stay put. The outer box carries the
 * card's hairline below the list, so it holds still as the rows move.
 */
export function FirstRunCardList({
  children,
  className,
  ref,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div>
      <div ref={ref} className={cn("overflow-y-auto overscroll-contain", rowHairlines, className)}>
        {children}
      </div>
    </div>
  );
}

export function FirstRunRow({
  id,
  leading,
  label,
  detail,
  trailing,
}: {
  readonly id?: string;
  readonly leading?: ReactNode;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <div id={id} className="flex min-h-14 items-center gap-3 px-3.5 py-2.5">
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
