import {
  useId,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import {
  NodexCollapsiblePanel,
  NodexCollapsibleRoot,
  NodexCollapsibleTrigger,
} from "./collapsible";

export const CODEX_SETTINGS_SHELL_STYLE = {
  "--cursor-interaction": "pointer",
} as CSSProperties;

export type NodexSettingsNumberInputProps = Omit<ComponentProps<"input">, "type">;

export function NodexSettingsNumberInput({
  className,
  onKeyDown,
  ...props
}: NodexSettingsNumberInputProps) {
  return (
    <input
      {...props}
      type="number"
      data-slot="settings-number-input"
      onKeyDown={(event) => {
        if (event.key === "Enter") event.stopPropagation();
        onKeyDown?.(event);
      }}
      className={cn(
        "h-7 min-w-0 rounded-md border border-(--color-border-primary-outline) bg-(--color-background-primary-soft) px-2 py-0 text-sm text-(--color-text) tabular-nums outline-none",
        "focus:border-ring aria-invalid:border-text-danger aria-invalid:ring-2 aria-invalid:ring-text-danger/20",
        "disabled:cursor-not-allowed disabled:text-(--color-text-secondary)",
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
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  size?: "default" | "compact";
  variant?: "default" | "nested";
  children: ReactNode;
}

export function NodexSettingsRow({
  label,
  description,
  className,
  size = "default",
  variant = "default",
  children,
}: NodexSettingsRowProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-y-2 px-4",
        variant === "nested"
          ? "min-h-10 gap-x-3 py-2"
          : size === "compact"
            ? "gap-x-4 py-2"
            : "gap-x-6 py-3",
        className,
      )}
    >
      <div className="flex min-w-32 flex-1 items-center gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div
            className={cn(
              "min-w-0 text-sm text-token-text-primary",
              variant === "default" && "font-medium",
            )}
          >
            {label}
          </div>
          {description ? (
            <div className="min-w-0 break-words text-xs leading-4 text-balance text-token-text-secondary">
              {description}
            </div>
          ) : null}
        </div>
      </div>
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}

const SETTINGS_CARD_CLASS_NAME =
  "flex flex-col overflow-hidden rounded-2xl border border-token-border";
const SETTINGS_CARD_STYLE = {
  backgroundColor: "var(--color-background-panel, var(--color-token-bg-fog))",
} satisfies CSSProperties;
/** Inset hairlines between a card's direct children. */
const SETTINGS_CARD_DIVIDERS = cn(
  "[&>*:not(:last-child)]:relative [&>*:not(:last-child)]:after:pointer-events-none",
  "[&>*:not(:last-child)]:after:absolute [&>*:not(:last-child)]:after:inset-x-4",
  "[&>*:not(:last-child)]:after:bottom-0 [&>*:not(:last-child)]:after:h-px",
  "[&>*:not(:last-child)]:after:bg-token-border [&>*:not(:last-child)]:after:content-['']",
);

export interface NodexSettingsDisclosureState {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Open state for a page's collapsible sections, all closed by default. A revealed id, such as
 * the section a deep link or search result lands on, opens whenever it changes.
 */
export function useNodexSettingsDisclosures(revealed: string | null = null) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(
    () => new Set(revealed ? [revealed] : []),
  );
  const [lastRevealed, setLastRevealed] = useState(revealed);
  if (revealed !== lastRevealed) {
    setLastRevealed(revealed);
    if (revealed && !openIds.has(revealed)) setOpenIds(new Set(openIds).add(revealed));
  }
  return (id: string): NodexSettingsDisclosureState => ({
    open: openIds.has(id),
    onOpenChange: (open) =>
      setOpenIds((current) => {
        const next = new Set(current);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
  });
}

/**
 * A collapsible settings card. Its header names the area in plain words and, while closed,
 * summarizes the current state so the page reads as an overview. Closed content stays mounted,
 * so drafts survive collapsing.
 */
function NodexSettingsDisclosureSection({
  id,
  title,
  description,
  icon,
  summary,
  action,
  disclosure,
  children,
  cardClassName,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  summary?: ReactNode;
  action?: ReactNode;
  disclosure: NodexSettingsDisclosureState;
  children: ReactNode;
  cardClassName?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const summaryId = useId();
  const showSummary = !disclosure.open && summary !== undefined && summary !== null;
  const describedBy = [showSummary ? summaryId : null, description ? descriptionId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <section id={id} aria-labelledby={titleId} className="flex scroll-mt-4 flex-col">
      <NodexCollapsibleRoot
        open={disclosure.open}
        onOpenChange={disclosure.onOpenChange}
        className={cn(SETTINGS_CARD_CLASS_NAME, cardClassName)}
        style={SETTINGS_CARD_STYLE}
      >
        <div className="flex items-center">
          <h2 className="flex min-w-0 flex-1">
            <NodexCollapsibleTrigger
              render={
                <button
                  type="button"
                  aria-labelledby={titleId}
                  aria-describedby={describedBy || undefined}
                  className={cn(
                    "flex min-h-14 min-w-0 flex-1 cursor-interaction items-center gap-3 px-4 py-3 text-start outline-none",
                    "hover:bg-token-list-hover-background focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset",
                  )}
                />
              }
            >
              {icon ? (
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center text-token-text-primary [&>svg]:size-[18px]"
                >
                  {icon}
                </span>
              ) : null}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span id={titleId} className="text-sm font-medium text-token-text-primary">
                  {title}
                </span>
                {description ? (
                  <span
                    id={descriptionId}
                    className="text-xs leading-4 text-balance text-token-text-secondary"
                  >
                    {description}
                  </span>
                ) : null}
              </span>
              {showSummary ? (
                <span
                  id={summaryId}
                  className="max-w-[45%] shrink-0 truncate text-end text-sm text-token-text-secondary"
                >
                  {summary}
                </span>
              ) : null}
              <ChevronDownIcon
                className={cn(
                  "size-3.5 shrink-0 text-token-description-foreground transition-transform duration-150",
                  !disclosure.open && "-rotate-90",
                )}
              />
            </NodexCollapsibleTrigger>
          </h2>
          {action ? <div className="flex shrink-0 items-center pe-4">{action}</div> : null}
        </div>
        <NodexCollapsiblePanel
          keepMounted
          className={cn(
            "relative flex flex-col data-[closed]:hidden",
            "before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-token-border before:content-['']",
            SETTINGS_CARD_DIVIDERS,
          )}
        >
          {children}
        </NodexCollapsiblePanel>
      </NodexCollapsibleRoot>
    </section>
  );
}

export function NodexSettingsSection({
  id,
  title,
  titlePlacement = "outside",
  description,
  icon,
  summary,
  action,
  disclosure,
  children,
  cardClassName,
}: {
  id?: string;
  title?: string;
  titlePlacement?: "outside" | "inside";
  /** Collapsible sections only: a plain-language line under the title. */
  description?: ReactNode;
  /** Collapsible sections only: the area's mark, before the title. */
  icon?: ReactNode;
  /** Collapsible sections only: the current state, shown while closed. */
  summary?: ReactNode;
  /** Collapsible sections only: a header control outside the toggle. */
  action?: ReactNode;
  /** Makes the section a collapsible card whose header holds its title. */
  disclosure?: NodexSettingsDisclosureState;
  children: ReactNode;
  cardClassName?: string;
}) {
  const titleId = useId();

  if (disclosure && title) {
    return (
      <NodexSettingsDisclosureSection
        id={id}
        title={title}
        description={description}
        icon={icon}
        summary={summary}
        action={action}
        disclosure={disclosure}
        cardClassName={cardClassName}
      >
        {children}
      </NodexSettingsDisclosureSection>
    );
  }

  return (
    <section id={id} aria-labelledby={title ? titleId : undefined} className="flex flex-col">
      {title && titlePlacement === "outside" ? (
        <h2
          id={titleId}
          className="min-h-toolbar pb-1.5 text-base font-medium text-token-text-primary"
        >
          {title}
        </h2>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <div
          className={cn(SETTINGS_CARD_CLASS_NAME, SETTINGS_CARD_DIVIDERS, cardClassName)}
          style={SETTINGS_CARD_STYLE}
        >
          {title && titlePlacement === "inside" ? (
            <h2
              id={titleId}
              className="flex min-h-10 items-center px-4 py-2 text-sm font-medium text-token-text-primary"
            >
              {title}
            </h2>
          ) : null}
          {children}
        </div>
      </div>
    </section>
  );
}

/**
 * One item in a settings list, such as an Agent profile. The header names it and keeps its
 * quick controls; the item's full configuration opens in place below it.
 */
export function NodexSettingsExpandableRow({
  id,
  label,
  detail,
  expanded,
  onExpandedChange,
  controls,
  progress,
  notice,
  toggleRef,
  children,
}: {
  id?: string;
  label: ReactNode;
  /** A secondary line under the label, such as the command it runs. */
  detail?: ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Status and quick actions after the label, outside the expand toggle. */
  controls?: ReactNode;
  /** An absolutely positioned indicator along the header's bottom edge. */
  progress?: ReactNode;
  /** A message under the header that stays visible while collapsed. */
  notice?: ReactNode;
  /** The header's expand toggle, where focus can return when a quick control goes away. */
  toggleRef?: Ref<HTMLButtonElement>;
  /** The expanded configuration, mounted only while open. */
  children: ReactNode;
}) {
  const detailId = useId();
  return (
    <div id={id} className="flex scroll-mt-4 flex-col">
      <div className="relative flex min-h-14 items-center gap-3 px-4 py-2.5">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? detailId : undefined}
          className="flex min-w-0 flex-1 cursor-interaction items-center gap-3 rounded-md text-start outline-hidden focus-visible:ring-2 focus-visible:ring-token-focus-border"
          onClick={() => onExpandedChange(!expanded)}
        >
          <ChevronRightIcon
            className={cn(
              "icon-2xs shrink-0 text-token-description-foreground transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-token-text-primary">{label}</span>
            {detail ? (
              <span className="block min-w-0 truncate text-xs text-token-description-foreground">
                {detail}
              </span>
            ) : null}
          </span>
        </button>
        {controls}
        {progress}
      </div>
      {notice}
      {expanded ? (
        <div id={detailId} className="flex flex-col bg-token-foreground/[0.015]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** The last row of a settings list, adding another item to it. */
export function NodexSettingsAddRow({
  id,
  label,
  disabled = false,
  onClick,
}: {
  id?: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-11 w-full items-center gap-2.5 px-4 text-start text-sm text-token-text-secondary outline-none",
        "focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-interaction hover:bg-token-list-hover-background hover:text-token-text-primary",
      )}
    >
      <PlusIcon className="icon-2xs shrink-0" />
      {label}
    </button>
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
      className={cn("flex h-full min-h-0 w-full flex-col", className)}
      style={CODEX_SETTINGS_SHELL_STYLE}
    >
      {backSlot ? <div className="flex items-center px-panel">{backSlot}</div> : null}
      <div className="flex-1 overflow-y-auto p-panel">
        <div
          className={cn(
            "mx-auto flex w-full min-w-0 flex-col",
            fullWidth ? null : "max-w-3xl",
            contentClassName,
          )}
        >
          <div className="flex items-center justify-between gap-3 pb-panel">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
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
