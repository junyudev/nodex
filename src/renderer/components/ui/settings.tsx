import {
  useId,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "@/components/shared/icons";
import { useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NodexButton } from "./button";
import { NODEX_SETTINGS_FIELD_CHROME_CLASS_NAME, Textarea } from "./input";
import { ToolbarButton } from "./toolbar-button";
import {
  NodexCollapsiblePanel,
  NodexCollapsibleRoot,
  NodexCollapsibleTrigger,
} from "./collapsible";

export const CODEX_SETTINGS_SHELL_STYLE = {
  "--cursor-interaction": "pointer",
} as CSSProperties;

/** One size for a settings row's text input or picker, so the fields in a section line up. */
export const NODEX_SETTINGS_FIELD_CLASS_NAME = "h-8 w-64 max-w-full text-sm";

/**
 * A row people click or select in a flat Settings list. Its content keeps the column's edges,
 * while the hover and selected plate reaches into the gutter, so text never meets the plate's
 * edge and the dividers between rows stay visible.
 */
export const NODEX_SETTINGS_INTERACTIVE_ROW_CLASS_NAME = cn(
  "relative isolate",
  "before:pointer-events-none before:absolute before:-inset-x-2 before:inset-y-px before:-z-10 before:rounded-lg before:content-['']",
  "hover:before:bg-(--color-background-secondary-ghost-hover)",
);

/** The plate of a selected interactive row. */
export const NODEX_SETTINGS_SELECTED_ROW_CLASS_NAME =
  "before:bg-(--color-background-secondary-ghost-hover)";

/** A scrolling Settings list leaves room for its rows' plates and an overlay scrollbar. */
export const NODEX_SETTINGS_LIST_SCROLLER_CLASS_NAME = "-mx-2 px-2";

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
        "h-7 min-w-0 px-2 py-0 text-sm text-(--color-text) tabular-nums outline-none",
        NODEX_SETTINGS_FIELD_CHROME_CLASS_NAME,
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
  /** Some, but not all, of what this checkbox stands for is checked. */
  indeterminate?: boolean;
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
  indeterminate = false,
  onCheckedChange,
}: NodexCheckboxProps) {
  const marked = checked || indeterminate;
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-label={ariaLabel}
      aria-checked={indeterminate ? "mixed" : checked}
      data-state={marked ? "checked" : "unchecked"}
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
      {indeterminate ? (
        <span aria-hidden className="h-px w-2 rounded-full bg-current" />
      ) : checked ? (
        <NodexCheckboxCheckIcon />
      ) : null}
    </button>
  );
}

export interface NodexSettingsRowProps {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  size?: "default" | "compact";
  variant?: "default" | "nested";
  children: ReactNode;
}

/** A row's label and description, written the same way by every kind of settings row. */
function NodexSettingsRowText({
  label,
  description,
  variant,
}: {
  label: ReactNode;
  description?: ReactNode;
  variant: "default" | "nested";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-0.5">
      <div
        className={cn(
          "min-w-0 text-sm text-token-text-primary",
          variant === "default" && "font-medium",
        )}
      >
        {label}
      </div>
      {description ? (
        <div className="min-w-0 break-words text-sm font-normal text-pretty text-token-text-secondary">
          {description}
        </div>
      ) : null}
    </div>
  );
}

export function NodexSettingsRow({
  id,
  label,
  description,
  className,
  size = "default",
  variant = "default",
  children,
}: NodexSettingsRowProps) {
  return (
    <div
      id={id}
      className={cn(
        "flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-2",
        variant === "nested" || size === "compact" ? "py-1.5" : "py-2",
        className,
      )}
    >
      <div className="flex min-w-32 flex-1 items-center gap-3">
        <NodexSettingsRowText label={label} description={description} variant={variant} />
      </div>
      <div className="ms-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}

/**
 * A setting whose control needs the row's whole width, such as a text field. Its label and
 * description line up with the rows around it, and the control follows underneath.
 */
export function NodexSettingsStackedRow({
  id,
  label,
  description,
  children,
}: {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className="flex flex-col gap-2 py-2">
      <NodexSettingsRowText label={label} description={description} variant="default" />
      {children}
    </div>
  );
}

export type NodexSettingsTextFieldProps = Omit<
  ComponentProps<"textarea">,
  "value" | "defaultValue" | "onChange" | "onBlur"
> & {
  /** The saved text, shown whenever no edit is pending. */
  readonly value: string;
  /** Saves the edited text; the field keeps showing it until the save succeeds. */
  readonly onCommit: (next: string) => Promise<unknown>;
};

/**
 * A settings text field saved when it loses focus, like every instruction field in Settings.
 * It grows with what is written, so short text stays short and long text needs no scrollbar
 * until it is long.
 */
export function NodexSettingsTextField({
  value,
  onCommit,
  className,
  ...props
}: NodexSettingsTextFieldProps) {
  // Null means no edit is pending, so the field always shows what is saved.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <Textarea
      variant="settings"
      {...props}
      value={draft ?? value}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (draft === null || saving) return;
        if (draft === value) return setDraft(null);
        const committed = draft;
        setSaving(true);
        void onCommit(committed)
          .then(
            // A later edit made while this one saved stays pending.
            () => setDraft((current) => (current === committed ? null : current)),
            // The owner reports the failure; the text stays so nothing typed is lost.
            () => undefined,
          )
          .finally(() => setSaving(false));
      }}
      className={cn(
        "field-sizing-content max-h-96 min-h-22 resize-none px-3 py-2 text-sm leading-relaxed",
        className,
      )}
    />
  );
}

/**
 * A setting with more to read or change underneath it, such as a guide or a list of models. The
 * row keeps the alignment of the rows around it; its Show button opens the detail in place.
 * `actions` sit before that button and `control`, such as a switch, after it, so the button never
 * moves under the pointer and a switch keeps the section's right edge.
 */
export function NodexSettingsRevealRow({
  id,
  label,
  description,
  variant = "default",
  open,
  onOpenChange,
  actions,
  control,
  children,
}: {
  id?: string;
  /** Also names the Show button, as in “Show Models”. */
  label: string;
  description?: ReactNode;
  variant?: "default" | "nested";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ReactNode;
  control?: ReactNode;
  /** The detail, mounted only while open. */
  children: ReactNode;
}) {
  const intl = useIntl();
  const detailId = useId();
  return (
    <div id={id} className="flex scroll-mt-4 flex-col">
      <NodexSettingsRow label={label} description={description} variant={variant}>
        {actions}
        <NodexButton
          size="toolbar"
          variant="ghostSecondary"
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          aria-label={intl.formatMessage(
            {
              id: "settings.revealRow.toggle",
              defaultMessage: "{open, select, true {Hide} other {Show}} {label}",
            },
            { open: String(open), label },
          )}
          className="gap-1"
          onClick={() => onOpenChange(!open)}
        >
          {open
            ? intl.formatMessage({ id: "settings.revealRow.hide", defaultMessage: "Hide" })
            : intl.formatMessage({ id: "settings.revealRow.show", defaultMessage: "Show" })}
          <ChevronDownIcon
            className={cn("icon-2xs transition-transform duration-150", open && "rotate-180")}
          />
        </NodexButton>
        {control}
      </NodexSettingsRow>
      {open ? (
        <div id={detailId} className="flex flex-col">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A section's rows lie flat on the page, divided by full-width lines; only the last row runs
 * open. A feature that needs a framed surface, such as a code preview, draws its own.
 */
const SETTINGS_GROUP_CLASS_NAME = cn(
  "flex flex-col",
  "[&>*:not(:last-child)]:relative [&>*:not(:last-child)]:after:pointer-events-none",
  "[&>*:not(:last-child)]:after:absolute [&>*:not(:last-child)]:after:inset-x-0",
  "[&>*:not(:last-child)]:after:bottom-0 [&>*:not(:last-child)]:after:h-px",
  "[&>*:not(:last-child)]:after:bg-(--color-border) [&>*:not(:last-child)]:after:content-['']",
);

/** A section's heading row: its title, and any section-wide action, over a full-width line. */
const SETTINGS_SECTION_HEADER_CLASS_NAME =
  "flex min-h-toolbar items-center justify-between gap-4 border-b border-(--color-border) pb-1.5";
const SETTINGS_SECTION_TITLE_CLASS_NAME = "text-base font-medium text-token-text-primary";

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
 * A collapsible settings section. Its heading names the area in plain words and, while closed,
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
  disclosureHeading,
  children,
  groupClassName,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  summary?: ReactNode;
  action?: ReactNode;
  disclosure: NodexSettingsDisclosureState;
  disclosureHeading?: "quiet";
  children: ReactNode;
  groupClassName?: string;
}) {
  const titleId = useId();
  const panelId = useId();
  const descriptionId = useId();
  const summaryId = useId();
  const showSummary = !disclosure.open && summary !== undefined && summary !== null;
  const describedBy = [showSummary ? summaryId : null, description ? descriptionId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <section id={id} aria-labelledby={titleId} className="flex scroll-mt-4 flex-col">
      <NodexCollapsibleRoot open={disclosure.open} onOpenChange={disclosure.onOpenChange}>
        <div className={cn(SETTINGS_SECTION_HEADER_CLASS_NAME, "py-1.5")}>
          <h2 className="flex min-w-0 flex-1">
            <NodexCollapsibleTrigger
              aria-controls={panelId}
              render={
                <button
                  type="button"
                  aria-labelledby={titleId}
                  aria-describedby={describedBy || undefined}
                  className={cn(
                    "group/settings-disclosure flex min-w-0 cursor-interaction items-center gap-3 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border",
                    disclosureHeading !== "quiet" && "flex-1",
                  )}
                />
              }
            >
              {icon ? (
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center text-token-text-primary [&>svg]:size-4"
                >
                  {icon}
                </span>
              ) : null}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1">
                  <span
                    id={titleId}
                    className={cn(
                      SETTINGS_SECTION_TITLE_CLASS_NAME,
                      "truncate",
                      disclosureHeading === "quiet" &&
                        "text-tertiary group-hover/settings-disclosure:text-token-text-primary",
                    )}
                  >
                    {title}
                  </span>
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 shrink-0 text-tertiary transition-transform duration-150 group-hover/settings-disclosure:text-token-text-primary",
                      disclosure.open && "rotate-90",
                    )}
                  />
                </span>
                {description ? (
                  <span
                    id={descriptionId}
                    className="text-sm text-pretty text-token-text-secondary"
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
            </NodexCollapsibleTrigger>
          </h2>
          {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
        </div>
        <NodexCollapsiblePanel
          id={panelId}
          keepMounted
          className={cn(SETTINGS_GROUP_CLASS_NAME, "data-[closed]:hidden", groupClassName)}
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
  description,
  icon,
  summary,
  action,
  disclosure,
  disclosureHeading,
  footnote,
  children,
  groupClassName,
}: {
  id?: string;
  title?: string;
  /** Collapsible sections only: a plain-language line under the title. */
  description?: ReactNode;
  /** Collapsible sections only: the area's mark, before the title. */
  icon?: ReactNode;
  /** Collapsible sections only: the current state, shown while closed. */
  summary?: ReactNode;
  /** A section-wide control at the end of the heading row. */
  action?: ReactNode;
  /** Makes the section collapsible from its heading. */
  disclosure?: NodexSettingsDisclosureState;
  /** Uses a tertiary title and a button fitted to the heading copy. */
  disclosureHeading?: "quiet";
  /** Plain sections only: one quiet line under the rows that holds for every row in it. */
  footnote?: ReactNode;
  children: ReactNode;
  /** Layout for the rows' group, such as a fixed height for a list that scrolls. */
  groupClassName?: string;
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
        disclosureHeading={disclosureHeading}
        groupClassName={groupClassName}
      >
        {children}
      </NodexSettingsDisclosureSection>
    );
  }

  return (
    <section id={id} aria-labelledby={title ? titleId : undefined} className="flex flex-col">
      {title ? (
        <div className={SETTINGS_SECTION_HEADER_CLASS_NAME}>
          <h2 id={titleId} className={SETTINGS_SECTION_TITLE_CLASS_NAME}>
            {title}
          </h2>
          {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
        </div>
      ) : null}
      <div className={cn(SETTINGS_GROUP_CLASS_NAME, groupClassName)}>{children}</div>
      {footnote ? (
        <p className="pt-1.5 text-sm text-pretty text-token-text-secondary">{footnote}</p>
      ) : null}
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
      <div className="relative flex min-h-12 items-center gap-3 py-2">
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
              <span className="block min-w-0 truncate text-sm text-token-text-secondary">
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
        // The detail hangs under the label, past the disclosure chevron, so it reads as the item's.
        <div id={detailId} data-settings-detail="" className="flex flex-col ps-[22px] pb-2">
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
        "flex min-h-10 w-full items-center gap-2 text-start text-sm text-token-text-secondary outline-none",
        "rounded-lg focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-interaction hover:text-token-text-primary",
      )}
    >
      <PlusIcon className="icon-2xs shrink-0" />
      {label}
    </button>
  );
}

export interface NodexSettingsTab<Id extends string> {
  readonly id: Id;
  readonly label: string;
  /** How many items the tab holds, when that is known. */
  readonly count?: number;
}

/** A page's tabs, such as Plugins' kinds of extension or Worktrees' Environments. */
export function NodexSettingsTabs<Id extends string>({
  label,
  tabs,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly tabs: readonly NodexSettingsTab<Id>[];
  readonly selected: Id;
  readonly onSelect: (tab: Id) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="hide-scrollbar relative inline-flex max-w-full min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden"
      onWheel={(event) => {
        const delta = event.deltaX || event.deltaY;
        if (delta !== 0) event.currentTarget.scrollLeft += delta;
      }}
    >
      {tabs.map((tab) => {
        const isSelected = tab.id === selected;
        return (
          <ToolbarButton
            key={tab.id}
            aria-pressed={isSelected}
            color="ghost"
            className={cn(
              "shrink-0 focus-visible:ring-inset",
              isSelected &&
                "bg-[color-mix(in_oklab,var(--color-text)_5%,transparent)] text-token-foreground",
            )}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {tab.count === undefined ? null : (
              <span className="ms-0.5 text-tertiary">{tab.count}</span>
            )}
          </ToolbarButton>
        );
      })}
    </div>
  );
}

export function NodexSettingsPageSurface({
  title,
  backSlot,
  subtitle,
  children,
  contentClassName,
  action,
  className,
}: {
  title: string;
  backSlot?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
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
      {backSlot ? <div className="flex items-center px-panel pt-2">{backSlot}</div> : null}
      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div
          className={cn(
            "mx-auto flex w-full max-w-3xl min-w-0 flex-col px-panel pt-4 pb-panel",
            contentClassName,
          )}
        >
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 id={titleId} className="heading-xl break-words text-token-text-primary">
                {title}
              </h1>
              {subtitle ? (
                <p className="break-words text-base leading-6 text-balance text-token-text-secondary">
                  {subtitle}
                </p>
              ) : null}
            </div>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
          <div className="mt-5 flex flex-col gap-10">{children}</div>
        </div>
      </div>
    </main>
  );
}
