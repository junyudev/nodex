import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./section-header";

/*
 * The building blocks of an item's detail page: a centered column of blocks 24px apart, whose
 * text is inset by one row padding so it lines up with the rows inside its sections.
 */

/** Stacks blocks with the page's section gap. */
export const DETAIL_SECTION_GROUP_CLASS = "flex flex-col gap-(--detail-page-section-gap)";

/** The page column: centered, at most a conversation wide. */
export function DetailSections({ children }: { readonly children?: ReactNode }) {
  return (
    <div
      className={cn(
        DETAIL_SECTION_GROUP_CLASS,
        "@container mx-auto w-full max-w-(--thread-content-max-width) [--detail-page-inline-inset:var(--padding-row-x)] [--detail-page-section-gap:calc(var(--spacing)*6)]",
      )}
    >
      {children}
    </div>
  );
}

/** The header row: the logo beside the title and subtitle, with the actions at the end. */
export function DetailHeader({
  asset,
  title,
  subtitle,
  actions,
}: {
  readonly asset: ReactNode;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 px-(--detail-page-inline-inset)">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-[16rem] items-center gap-3">
          {asset}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {title}
            {subtitle == null ? null : (
              <div className="text-base text-(--color-text-secondary)">{subtitle}</div>
            )}
          </div>
        </div>
        {actions == null ? null : (
          <div className="flex max-w-full shrink-0 items-center gap-2 empty:hidden">{actions}</div>
        )}
      </div>
    </header>
  );
}

/** The 60px bordered frame of a detail page's logo. */
export function DetailLogo({ children }: { readonly children?: ReactNode }) {
  return (
    <span className="flex size-15 shrink-0 items-center justify-center overflow-hidden rounded-[1rem] border border-(--color-border)">
      {children}
    </span>
  );
}

/**
 * A titled block. Inset content lines up with the title; rows that carry their own padding opt
 * out with `inset={false}`.
 */
export function DetailSection({
  id,
  title,
  count,
  action,
  inset = true,
  showDivider = true,
  children,
}: {
  readonly id?: string;
  readonly title: ReactNode;
  readonly count?: ReactNode;
  readonly action?: ReactNode;
  readonly inset?: boolean;
  readonly showDivider?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <section
      id={id}
      className="flex flex-col gap-4 [--sectioned-page-leading-inset:var(--detail-page-inline-inset,0px)]"
    >
      <SectionHeader title={title} count={count} action={action} showDivider={showDivider} />
      <div className={cn("flex flex-col gap-1", inset && "px-(--detail-page-inline-inset,0px)")}>
        {children}
      </div>
    </section>
  );
}

/**
 * One label/value row of a property list. The label takes a fixed column once the page is at
 * least 24rem wide; below that it stacks above the value.
 */
export function DetailProperty({
  label,
  align = "center",
  children,
}: {
  readonly label: ReactNode;
  readonly align?: "center" | "start";
  readonly children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid min-h-(--height-token-row) grid-cols-[minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 py-(--padding-row-y) text-(length:--detail-row-font-size,var(--text-base)) leading-5 @min-[24rem]:grid-cols-[var(--detail-property-label-width,120px)_minmax(0,1fr)]",
        align === "center" && "@min-[24rem]:items-center",
      )}
    >
      <dt className="flex min-w-0 items-center gap-2 wrap-anywhere text-token-description-foreground">
        {label}
      </dt>
      <dd className="m-0 flex min-w-0 items-center wrap-anywhere text-token-foreground">
        {children}
      </dd>
    </div>
  );
}

/** A rounded panel over a dimmed backdrop image, holding a centered column of prompts. */
export function PromptPreview({
  backgroundUrl,
  children,
}: {
  readonly backgroundUrl: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="relative mx-(--detail-page-inline-inset) flex justify-center overflow-hidden rounded-[1rem] px-4 py-8 sm:px-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 size-full bg-cover bg-center"
        style={{ backgroundImage: `url("${backgroundUrl}")` }}
      />
      <div className="absolute inset-0 bg-[color-mix(in_oklab,var(--color-surface-secondary)_70%,transparent)]" />
      <div className="relative flex w-full max-w-160 flex-col items-center gap-4">{children}</div>
    </div>
  );
}

/**
 * A prompt bubble with a round arrow. Disabled prompts dim and drop the arrow; pending prompts
 * ignore clicks without changing their look.
 */
export function PromptButton({
  arrow,
  disabled = false,
  pending = false,
  onClick,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> & {
  readonly arrow: ReactNode;
  readonly disabled?: boolean;
  readonly pending?: boolean;
}) {
  return (
    <button
      {...props}
      type="button"
      aria-disabled={disabled || undefined}
      tabIndex={pending ? -1 : 0}
      className="max-w-[77%] cursor-interaction rounded-[1rem] bg-[color-mix(in_oklab,var(--color-surface-secondary)_75%,transparent)] py-2 ps-2 pe-1.5 text-start text-size-chat wrap-break-word text-token-foreground outline-none not-aria-disabled:hover:bg-(--color-surface-secondary) not-aria-disabled:focus-visible:bg-(--color-surface-secondary) not-aria-disabled:focus-visible:ring-2 not-aria-disabled:focus-visible:ring-token-focus-border aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      onClick={(event) => {
        if (!disabled && !pending) onClick?.(event);
      }}
    >
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 text-pretty wrap-break-word">{children}</span>
        {disabled ? null : (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-text/10">
            {arrow}
          </span>
        )}
      </span>
    </button>
  );
}
