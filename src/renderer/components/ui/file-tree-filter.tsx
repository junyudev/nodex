import { useId } from "react";
import { CloseIcon } from "@/components/shared/icons";
import { MagnifyingGlassIcon } from "@/components/shared/icons/customize-action-icons";

export function FileTreeFilter({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="no-drag flex h-token-button-composer items-center gap-2 rounded-full border border-(--color-border-primary-outline) bg-transparent px-3 py-0 text-sm leading-[18px]">
      <span className="flex shrink-0 items-center justify-center">
        <MagnifyingGlassIcon className="semantic-text-secondary" />
      </span>
      <label className="sr-only" htmlFor={id}>
        Filter files
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter files…"
        className="min-w-0 flex-1 bg-transparent text-sm leading-5 text-(--color-text) outline-none select-text placeholder:text-(--color-text-tertiary) [&::placeholder]:select-none"
      />
      {value.length > 0 ? (
        <button
          type="button"
          aria-label="Clear file filter"
          className="-me-1.5 flex size-5 shrink-0 cursor-interaction items-center justify-center rounded-full text-tertiary hover:text-(--color-text)"
          onClick={() => onChange("")}
        >
          <CloseIcon className="icon-2xs" />
        </button>
      ) : null}
    </div>
  );
}
