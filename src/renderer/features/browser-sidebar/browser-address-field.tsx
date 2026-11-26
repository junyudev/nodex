import { useId, useRef, type ComponentProps, type ReactNode } from "react";
import { SearchIcon, SidePanelBrowserIcon } from "@/components/shared/icons";
import { ViewerCapsule, ViewerInputCapsule } from "@/components/ui/viewer-header";
import { useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  BrowserAddressSuggestion,
  BrowserAddressWorkspaceCandidate,
} from "./browser-address-suggestions";
import { BrowserPermissionPromptPopover } from "./browser-permission-prompt";
import { shouldSkipBrowserAddressCommit } from "./browser-sidebar-ui-model";

export interface BrowserAddressWorkspaceOption extends BrowserAddressWorkspaceCandidate {
  readonly icon: ReactNode;
  /** The title as shown, such as with its matched text emphasized; `title` stays its name. */
  readonly label?: ReactNode;
  /** A New tab row's second line: what the option is and where, or why it matched. */
  readonly detail?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onSelect: () => void;
}

export type BrowserAddressRow = BrowserAddressSuggestion<BrowserAddressWorkspaceOption>;

export function browserAddressOptionId(listId: string, index: number): string {
  return `${listId}-${index}`;
}

type BrowserAddressFieldProps = {
  readonly value: string;
  readonly focused: boolean;
  readonly isCombobox: boolean;
  readonly suggestions: {
    readonly rows: readonly BrowserAddressRow[];
    readonly highlightedIndex: number;
    readonly onHighlight: (id: string | null) => void;
    readonly onSelect: (row: BrowserAddressRow) => void;
  };
  readonly onChange: (value: string) => void;
  readonly onFocusChange: (focused: boolean) => void;
  readonly onCommit: () => void;
  readonly onReset: () => void;
} & (
  | {
      readonly variant: "toolbar";
      /** The toolbar shows its suggestions in a dropdown beneath the field. */
      readonly dropdown: { readonly open: boolean; readonly onDismiss: () => void };
      readonly siteInfo: ReactNode;
      readonly openExternally: ReactNode;
      readonly permission: Omit<ComponentProps<typeof BrowserPermissionPromptPopover>, "anchor">;
    }
  | {
      readonly variant: "new-tab";
      /** The New tab page lays out the field's list itself; see `BrowserNewTabList`. */
      readonly listId: string;
    }
);

export function BrowserAddressField(props: BrowserAddressFieldProps) {
  const { value, focused, isCombobox, suggestions, onChange, onFocusChange, onCommit, onReset } =
    props;
  const intl = useIntl();
  const dropdownId = useId();
  const addressBarRef = useRef<HTMLDivElement>(null);
  const skipCommitRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isNewTab = props.variant === "new-tab";
  const listId = props.variant === "new-tab" ? props.listId : dropdownId;
  // A New tab's list is always on its page; the toolbar's opens beneath the field.
  const listShown = props.variant === "new-tab" ? suggestions.rows.length > 0 : props.dropdown.open;
  // An empty New tab field suggests without preselecting; a query always has a row to accept.
  const hasQuery = value.trim().length > 0;
  const toolbarHasValue = !isNewTab && value.trim().length > 0;
  const placeholder = isNewTab
    ? intl.formatMessage({
        id: "browser.browserSidebarPanel.newTabSearchPlaceholder",
        defaultMessage: "Search pages or enter a URL",
      })
    : intl.formatMessage({
        id: "browser.browserSidebarPanel.addressPlaceholder",
        defaultMessage: "Search or enter a URL",
      });

  const highlightedRow = listShown ? suggestions.rows[suggestions.highlightedIndex] : undefined;
  const activeOptionId = highlightedRow
    ? browserAddressOptionId(listId, suggestions.highlightedIndex)
    : undefined;

  const selectSuggestion = (row: BrowserAddressRow) => {
    if (row.kind === "workspace") skipCommitRef.current = true;
    suggestions.onSelect(row);
  };

  const submitAddress = () => {
    if (highlightedRow) {
      selectSuggestion(highlightedRow);
      return;
    }
    onCommit();
  };

  // Arrow keys wrap through a query's rows. Before typing, the list starts unselected and
  // Up from its first row returns there.
  const moveHighlight = (delta: 1 | -1) => {
    const count = suggestions.rows.length;
    const current = suggestions.highlightedIndex;
    const next = hasQuery
      ? (current + delta + count) % count
      : Math.min(Math.max(current + delta, -1), count - 1);
    suggestions.onHighlight(suggestions.rows[next]?.id ?? null);
    // Keyboard moves keep their row, or the field they return to, in view; pointer highlights
    // never scroll the list.
    revealRow(next);
  };
  const revealRow = (index: number) => {
    const target =
      index >= 0
        ? document.getElementById(browserAddressOptionId(listId, index))
        : inputRef.current;
    target?.scrollIntoView?.({ block: "nearest" });
  };

  const input = (
    <input
      ref={inputRef}
      data-browser-sidebar-address-input="true"
      // Like a browser's address bar, Close tab and tab switching still work while typing here.
      data-panel-tab-shortcuts-pass-through=""
      role={isCombobox ? "combobox" : undefined}
      aria-label={placeholder}
      aria-expanded={isCombobox ? listShown : undefined}
      aria-controls={listShown ? listId : undefined}
      aria-activedescendant={activeOptionId}
      aria-autocomplete={isCombobox ? "list" : undefined}
      className={
        isNewTab
          ? "h-full min-w-0 flex-1 bg-transparent text-sm text-start text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground"
          : cn(
              "h-full min-w-0 flex-1 bg-transparent px-1 text-sm outline-none text-token-input-foreground placeholder:text-token-input-placeholder-foreground focus:pl-2 focus:text-left",
              !focused && "text-center",
              toolbarHasValue && "pr-3",
            )
      }
      style={
        toolbarHasValue
          ? {
              WebkitMaskImage: "linear-gradient(to right, black calc(100% - 18px), transparent)",
              maskImage: "linear-gradient(to right, black calc(100% - 18px), transparent)",
            }
          : undefined
      }
      value={value}
      placeholder={placeholder}
      onFocus={() => {
        skipCommitRef.current = false;
        onFocusChange(true);
      }}
      onBlur={(event) => {
        onFocusChange(false);
        // A New tab's search only runs on Enter; leaving it keeps the draft for later.
        if (isNewTab) return;
        if (skipCommitRef.current) {
          skipCommitRef.current = false;
          return;
        }
        if (shouldSkipBrowserAddressCommit(event.relatedTarget)) return;
        onCommit();
      }}
      onChange={(event) => {
        skipCommitRef.current = false;
        onChange(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (listShown && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          moveHighlight(event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (event.key === "Enter" && highlightedRow) {
          event.preventDefault();
          submitAddress();
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        // A New tab clears its search first, then lets go of a highlighted suggestion, then
        // leaves the field. The toolbar closes its dropdown first, then restores the address.
        if (props.variant === "new-tab" && hasQuery) {
          onChange("");
          return;
        }
        if (props.variant === "new-tab" && highlightedRow) {
          suggestions.onHighlight(null);
          revealRow(-1);
          return;
        }
        if (props.variant === "toolbar" && props.dropdown.open) {
          props.dropdown.onDismiss();
          return;
        }
        skipCommitRef.current = true;
        event.currentTarget.blur();
        onReset();
      }}
    />
  );

  return (
    <form
      className={
        isNewTab
          ? "relative min-w-0 no-drag"
          : "no-drag flex min-w-0 flex-1 items-center justify-center px-1 text-sm text-token-text-primary"
      }
      onSubmit={(event) => {
        event.preventDefault();
        submitAddress();
      }}
    >
      <div
        ref={addressBarRef}
        className={isNewTab ? undefined : "relative w-full min-w-0 max-w-[770px]"}
      >
        {props.variant === "new-tab" ? (
          // A raised surface that stays still while focused, unlike the toolbar's washing capsule.
          <ViewerCapsule className="cursor-text [--color-background-viewer-control:var(--color-surface-elevated-secondary)] [--viewer-control-height:3rem] dark:[--color-background-viewer-control:var(--color-background-composer-surface)]">
            <label
              className="flex h-full items-center gap-2 ps-3.25 pe-4"
              onMouseDown={(event) => {
                // Keep a click on the label padding from blurring and committing the draft.
                if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
              }}
            >
              <SearchIcon className="icon-sm shrink-0 text-token-text-secondary" aria-hidden />
              {input}
            </label>
          </ViewerCapsule>
        ) : (
          <>
            <ViewerInputCapsule className="group/address-bar flex min-w-0 w-full items-center overflow-hidden cursor-text focus-within:ring-1 focus-within:ring-inset focus-within:ring-token-border">
              <div
                className={cn(
                  "shrink-0 overflow-hidden transition-[width,opacity] duration-150",
                  focused ? "w-0 opacity-0" : "w-7 opacity-100",
                )}
              >
                {props.siteInfo}
              </div>
              {input}
              {props.openExternally}
            </ViewerInputCapsule>
            <BrowserPermissionPromptPopover {...props.permission} anchor={addressBarRef} />
          </>
        )}
        {props.variant === "toolbar" && props.dropdown.open ? (
          <div
            id={listId}
            role="listbox"
            aria-label={intl.formatMessage({
              id: "browser.browserSidebarPanel.addressSuggestions",
              defaultMessage: "Address suggestions",
            })}
            className={cn(
              "absolute top-full left-0 z-30 flex max-h-[min(360px,60vh)] w-full flex-col overflow-y-auto rounded-xl border border-token-border bg-token-dropdown-background p-1 text-token-text-primary shadow-lg",
            )}
          >
            {suggestions.rows.map((row, index) => (
              <div
                key={row.id}
                id={browserAddressOptionId(listId, index)}
                role="option"
                aria-selected={index === suggestions.highlightedIndex}
                className={cn(
                  "flex h-9 w-full shrink-0 cursor-interaction items-center gap-2.5 rounded-lg px-2.5 text-start text-[13px] outline-none select-none",
                  index === suggestions.highlightedIndex
                    ? "bg-token-list-hover-background"
                    : "hover:bg-token-list-hover-background/60",
                )}
                onMouseEnter={() => suggestions.onHighlight(row.id)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectSuggestion(row)}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-token-description-foreground">
                  {row.kind === "workspace" ? (
                    row.candidate.icon
                  ) : row.kind === "search" ? (
                    <SearchIcon className="icon-xs" />
                  ) : (
                    <SidePanelBrowserIcon className="icon-xs" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-token-text-primary">
                  {row.kind === "workspace"
                    ? (row.candidate.label ?? row.candidate.title)
                    : row.title}
                </span>
                <span className="shrink-0 text-token-description-foreground">
                  {row.kind === "workspace"
                    ? row.candidate.trailing
                    : row.kind === "url"
                      ? intl.formatMessage({
                          id: "browser.browserSidebarPanel.open",
                          defaultMessage: "Open",
                        })
                      : intl.formatMessage({
                          id: "browser.browserSidebarPanel.searchWeb",
                          defaultMessage: "Search the web",
                        })}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </form>
  );
}
