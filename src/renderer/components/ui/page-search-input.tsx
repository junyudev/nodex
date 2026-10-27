import { useRef, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";
import {
  ClearSearchIcon,
  MagnifyingGlassIcon,
} from "@/components/shared/icons/customize-action-icons";
import { cn } from "@/lib/utils";

export interface PageSearchInputProps {
  readonly id: string;
  /** Visually hidden label. */
  readonly label: string;
  readonly placeholder?: string;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (value: string) => void;
  readonly autoFocus?: boolean;
  readonly onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  /** Lets the page focus the input, e.g. for Command-F. */
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  /** Shown after the clear button, such as a fetching spinner. */
  readonly trailingControl?: ReactNode;
  readonly className?: string;
}

/**
 * The compact toolbar search of browse pages: a 32px outlined pill with a magnifier, an
 * input, and a clear button that refocuses the input before clearing.
 */
export function PageSearchInput({
  id,
  label,
  placeholder,
  searchQuery,
  onSearchQueryChange,
  autoFocus,
  onKeyDown,
  inputRef: providedInputRef,
  trailingControl,
  className,
}: PageSearchInputProps) {
  const ownInputRef = useRef<HTMLInputElement>(null);
  const inputRef = providedInputRef ?? ownInputRef;
  return (
    <div
      className={cn(
        "no-drag flex h-8 items-center gap-2 rounded-full border border-(--color-border-primary-outline) bg-transparent px-3 py-0 text-sm leading-5",
        className,
      )}
    >
      <span className="flex shrink-0 items-center justify-center">
        <MagnifyingGlassIcon className="text-(--color-text-secondary)" />
      </span>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        // A browse page's search is its primary affordance.
        autoFocus={autoFocus}
        type="text"
        autoComplete="off"
        value={searchQuery}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm leading-5 text-token-foreground outline-none select-text placeholder:text-tertiary [&::placeholder]:select-none"
        onChange={(event) => onSearchQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {searchQuery.length > 0 ? (
        <button
          type="button"
          aria-label="Clear search"
          className="flex shrink-0 cursor-interaction items-center justify-center text-(--color-text-secondary) hover:text-token-foreground"
          onClick={() => {
            inputRef.current?.focus();
            onSearchQueryChange("");
          }}
        >
          <ClearSearchIcon />
        </button>
      ) : null}
      {trailingControl == null ? null : (
        <div className="flex shrink-0 items-center">{trailingControl}</div>
      )}
    </div>
  );
}
