import { useId, type ComponentProps, type ReactNode } from "react";
import { SearchIcon, SidePanelBrowserIcon } from "@/components/shared/icons";
import { NodexOverflowTooltip } from "@/components/ui/tooltip";
import { useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { browserAddressOptionId, type BrowserAddressRow } from "./browser-address-field";

/**
 * The New tab search field's list. Before typing it holds what the field suggests; while
 * typing, what the query matches. The field keeps focus and drives it from the keyboard.
 */
export interface BrowserNewTabSuggestions {
  readonly listId: string;
  /** The trimmed draft; empty while the list shows what the field suggests. */
  readonly query: string;
  readonly rows: readonly BrowserAddressRow[];
  /** `-1` while nothing is highlighted, as before the first Arrow key on an empty field. */
  readonly highlightedIndex: number;
  readonly onHighlight: (id: string | null) => void;
  readonly onSelect: (row: BrowserAddressRow) => void;
}

const ROW_CLASS = cn(
  "cursor-interaction snap-start rounded-xl border-b border-token-border-light outline-none select-none",
  "aria-selected:border-transparent aria-selected:bg-token-list-hover-background",
  "[&:has(+li[aria-selected=true])]:border-transparent",
);

/**
 * Every row reads the same way: a glyph, the title, a second line saying what it is and where
 * (or why it matched), and an optional trailing hint such as an edit time.
 */
export function BrowserNewTabList({
  suggestions,
  className,
  onMouseLeave,
  ...listProps
}: {
  readonly suggestions: BrowserNewTabSuggestions;
} & Omit<ComponentProps<"ul">, "id" | "role" | "children">) {
  const { listId, rows, highlightedIndex, onHighlight, onSelect } = suggestions;
  return (
    <ul
      {...listProps}
      id={listId}
      role="listbox"
      className={className}
      // Leaving the list returns the highlight to its default, so no row looks stuck hovered.
      onMouseLeave={(event) => {
        onHighlight(null);
        onMouseLeave?.(event);
      }}
    >
      {rows.map((row, index) => (
        <BrowserNewTabOption
          key={row.id}
          row={row}
          id={browserAddressOptionId(listId, index)}
          selected={index === highlightedIndex}
          onHighlight={() => onHighlight(row.id)}
          onSelect={() => onSelect(row)}
        />
      ))}
    </ul>
  );
}

function BrowserNewTabOption({
  row,
  id,
  selected,
  onHighlight,
  onSelect,
}: {
  readonly row: BrowserAddressRow;
  readonly id: string;
  readonly selected: boolean;
  readonly onHighlight: () => void;
  readonly onSelect: () => void;
}) {
  const labelId = useId();
  const detailId = useId();
  const trailingId = useId();
  const { title, label, detail, icon, trailing } = useRowPresentation(row);
  // The option reads as its title line (with a matched Page key), described by its second line
  // and trailing hint, the way it looks.
  const describedBy = [detail ? detailId : null, trailing ? trailingId : null].filter(Boolean);
  return (
    <NodexOverflowTooltip content={title}>
      <li
        id={id}
        role="option"
        aria-selected={selected}
        aria-labelledby={labelId}
        aria-describedby={describedBy.length > 0 ? describedBy.join(" ") : undefined}
        className={ROW_CLASS}
        onMouseEnter={onHighlight}
        // Choosing with the pointer leaves focus in the search field.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSelect}
      >
        <span className="flex min-h-14 w-full min-w-0 items-center gap-3 px-3 py-2 text-start">
          <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-surface-elevated)] text-token-text-secondary">
            {icon}
          </span>
          <span className="min-w-0 flex-1">
            <span
              id={labelId}
              data-tooltip-overflow-target=""
              className="block truncate text-sm text-token-text-primary"
            >
              {label}
            </span>
            {detail ? (
              <span id={detailId} className="block truncate text-xs text-token-text-secondary">
                {detail}
              </span>
            ) : null}
          </span>
          {trailing ? (
            <span
              id={trailingId}
              className="flex shrink-0 items-center text-xs whitespace-nowrap text-token-text-secondary tabular-nums"
            >
              {trailing}
            </span>
          ) : null}
        </span>
      </li>
    </NodexOverflowTooltip>
  );
}

function useRowPresentation(row: BrowserAddressRow): {
  readonly title: string;
  readonly label: ReactNode;
  readonly detail: ReactNode;
  readonly icon: ReactNode;
  readonly trailing?: ReactNode;
} {
  const intl = useIntl();
  if (row.kind === "workspace") {
    const { candidate } = row;
    return {
      title: candidate.title,
      label: candidate.label ?? candidate.title,
      detail: candidate.detail,
      icon: candidate.icon,
      trailing: candidate.trailing,
    };
  }
  return row.kind === "url"
    ? {
        title: row.title,
        label: row.title,
        detail: intl.formatMessage({
          id: "browser.browserNewTabList.website",
          defaultMessage: "Website",
        }),
        icon: <SidePanelBrowserIcon className="icon-xs" />,
      }
    : {
        title: row.title,
        label: row.title,
        detail: intl.formatMessage({
          id: "browser.browserNewTabList.webSearch",
          defaultMessage: "Search the web",
        }),
        icon: <SearchIcon className="icon-xs" />,
      };
}
