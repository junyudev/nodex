import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from "react";
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
  readonly trailing?: ReactNode;
  readonly onSelect: () => void;
}

type AddressSuggestion = BrowserAddressSuggestion<BrowserAddressWorkspaceOption>;

type BrowserAddressFieldProps = {
  readonly value: string;
  readonly focused: boolean;
  readonly isCombobox: boolean;
  readonly suggestions: {
    readonly rows: readonly AddressSuggestion[];
    readonly open: boolean;
    readonly highlightedIndex: number;
    readonly onHighlight: (id: string | null) => void;
    readonly onDismiss: () => void;
    readonly onSelect: (row: AddressSuggestion) => void;
  };
  readonly onChange: (value: string) => void;
  readonly onFocusChange: (focused: boolean) => void;
  readonly onCommit: () => void;
  readonly onReset: () => void;
} & (
  | {
      readonly variant: "toolbar";
      readonly siteInfo: ReactNode;
      readonly openExternally: ReactNode;
      readonly permission: Omit<ComponentProps<typeof BrowserPermissionPromptPopover>, "anchor">;
    }
  | { readonly variant: "new-tab" }
);

export function BrowserAddressField(props: BrowserAddressFieldProps) {
  const { value, focused, isCombobox, suggestions, onChange, onFocusChange, onCommit, onReset } =
    props;
  const intl = useIntl();
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const addressBarRef = useRef<HTMLDivElement>(null);
  const skipCommitRef = useRef(false);
  const isNewTab = props.variant === "new-tab";
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

  const highlightedRow = suggestions.rows[suggestions.highlightedIndex];
  const activeOptionId = suggestions.open ? `${listId}-${suggestions.highlightedIndex}` : undefined;

  useEffect(() => {
    if (!activeOptionId) return;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  const selectSuggestion = (row: AddressSuggestion) => {
    if (row.kind === "workspace") skipCommitRef.current = true;
    suggestions.onSelect(row);
  };

  const submitAddress = () => {
    if (suggestions.open && highlightedRow) {
      selectSuggestion(highlightedRow);
      return;
    }
    onCommit();
  };

  const input = (
    <input
      data-browser-sidebar-address-input="true"
      // Like a browser's address bar, Close tab and tab switching still work while typing here.
      data-panel-tab-shortcuts-pass-through=""
      role={isCombobox ? "combobox" : undefined}
      aria-label={placeholder}
      aria-expanded={isCombobox ? suggestions.open : undefined}
      aria-controls={suggestions.open ? listId : undefined}
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
        if (suggestions.open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const count = suggestions.rows.length;
          const nextRow = suggestions.rows[(suggestions.highlightedIndex + delta + count) % count];
          suggestions.onHighlight(nextRow?.id ?? null);
          return;
        }
        if (suggestions.open && event.key === "Enter" && highlightedRow) {
          event.preventDefault();
          submitAddress();
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (suggestions.open) {
          suggestions.onDismiss();
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
        {suggestions.open ? (
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={intl.formatMessage({
              id: "browser.browserSidebarPanel.addressSuggestions",
              defaultMessage: "Address suggestions",
            })}
            className={cn(
              "absolute top-full left-0 z-30 flex max-h-[min(360px,60vh)] w-full flex-col overflow-y-auto rounded-xl border border-token-border bg-token-dropdown-background p-1 text-token-text-primary shadow-lg",
              isNewTab && "mt-1.5",
            )}
          >
            {suggestions.rows.map((row, index) => (
              <div
                key={row.id}
                id={`${listId}-${index}`}
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
                  {row.kind === "workspace" ? row.candidate.title : row.title}
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
