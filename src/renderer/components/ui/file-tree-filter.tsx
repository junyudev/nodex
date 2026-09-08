import { useId } from "react";
import { CloseIcon } from "@/components/shared/icons";
import { FileTreeSearchIcon } from "@/components/shared/icons/file-tree-search-icon";

export function FileTreeFilter({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="relative flex h-token-button-composer w-full items-center gap-1.5 rounded-lg border border-default bg-primary-soft-alpha text-base leading-[18px]">
      <label className="sr-only" htmlFor={id}>
        Filter files
      </label>
      <FileTreeSearchIcon className="ms-2 shrink-0 text-tertiary" />
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter files…"
        className="w-full min-w-0 appearance-none border-none bg-transparent py-0 ps-0 pe-1.5 text-default ring-0 outline-none select-text placeholder:text-tertiary focus:border-none focus:ring-0 focus:outline-none [&::placeholder]:select-none"
      />
      {value.length > 0 ? (
        <button
          type="button"
          aria-label="Clear file filter"
          className="flex size-7 shrink-0 cursor-interaction items-center justify-center rounded-md text-tertiary hover:text-default"
          onClick={() => onChange("")}
        >
          <CloseIcon className="icon-2xs" />
        </button>
      ) : null}
    </div>
  );
}
