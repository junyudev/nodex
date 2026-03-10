import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "../../../lib/utils";
import {
  BranchStatusIcon,
  CheckmarkIcon,
  PlusIcon,
  SearchIcon,
} from "@/components/shared/icons";
import {
  SELECTOR_MENU_DIVIDER_CLASS_NAME,
  SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME,
  SELECTOR_MENU_ITEM_CLASS_NAME,
  SELECTOR_MENU_LIST_CLASS_NAME,
  SELECTOR_MENU_PANEL_CLASS_NAME,
  SELECTOR_MENU_TITLE_CLASS_NAME,
  SelectorPopoverContent,
  SelectorPopoverTrigger,
} from "./selector-popover-primitives";

export interface BranchSelectorPopoverState {
  currentBranch: string | null;
  defaultBranch?: string | null;
  branches: string[];
}

interface BranchSelectorPopoverProps {
  cwd: string | null;
  state: BranchSelectorPopoverState;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onCheckout: (branch: string) => Promise<boolean>;
  onCreate?: (branch: string) => Promise<boolean>;
  selectedBranch?: string | null;
  disabled?: boolean;
  triggerClassName?: string;
}

function filterBranches(branches: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return branches;
  return branches.filter((branch) => branch.toLowerCase().includes(normalizedQuery));
}

export function BranchSelectorPopover({
  cwd,
  state,
  busy,
  onRefresh,
  onCheckout,
  onCreate,
  selectedBranch,
  disabled = false,
  triggerClassName,
}: BranchSelectorPopoverProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredBranches = useMemo(
    () => filterBranches(state.branches, search),
    [search, state.branches],
  );

  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }

    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [open]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen || !cwd) return;
    void onRefresh();
  }, [cwd, onRefresh]);

  const handleBranchClick = useCallback(async (branch: string) => {
    const didCheckout = await onCheckout(branch);
    if (!didCheckout) return;
    setOpen(false);
  }, [onCheckout]);

  const handleCreateClick = useCallback(async () => {
    if (!onCreate) return;

    const typedBranch = search.trim();
    const promptedBranch = typeof window !== "undefined" && !typedBranch
      ? window.prompt("Create and checkout new branch", "") ?? ""
      : "";
    const nextBranch = typedBranch || promptedBranch.trim();
    if (!nextBranch) return;

    const didCreate = await onCreate(nextBranch);
    if (!didCreate) return;
    setOpen(false);
  }, [onCreate, search]);

  const activeSelectedBranch = selectedBranch?.trim() || null;
  const triggerLabel = activeSelectedBranch ?? state.currentBranch ?? state.defaultBranch ?? "No branch";
  const isDisabled = disabled || !cwd || busy;
  const hasRepositoryState = state.currentBranch !== null || state.branches.length > 0 || Boolean(state.defaultBranch);
  const emptyBranchMessage = !cwd
    ? "Working directory unavailable"
    : !hasRepositoryState && !search.trim()
      ? "No Git repository detected"
      : "No matching branches";
  const canCreateBranch = Boolean(onCreate && cwd && !busy && hasRepositoryState);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <SelectorPopoverTrigger
        ariaLabel="Select Git branch"
        title={cwd ? triggerLabel : "Working directory unavailable"}
        label={triggerLabel}
        icon={<BranchStatusIcon className="shrink-0" />}
        disabled={isDisabled}
        className={triggerClassName}
      />
      <SelectorPopoverContent className="w-72">
        <div className={cn(SELECTOR_MENU_PANEL_CLASS_NAME, "w-full")}>
          <div className="flex w-full items-center rounded-md bg-foreground-5 px-2 py-1">
            <SearchIcon className="shrink-0 text-token-description-foreground" />
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search branches"
              className="w-full min-w-0 border-0 bg-transparent px-2 py-1 text-sm text-token-foreground outline-none placeholder:text-token-description-foreground"
            />
          </div>

          <div className={cn(SELECTOR_MENU_LIST_CLASS_NAME, "max-h-50 gap-1.5")}>
            <div className={SELECTOR_MENU_TITLE_CLASS_NAME}>Branches</div>
            <div className="flex flex-col">
              {filteredBranches.length === 0 ? (
                <div className="px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm text-token-description-foreground">
                  {emptyBranchMessage}
                </div>
              ) : (
                filteredBranches.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    disabled={busy}
                    onClick={() => void handleBranchClick(branch)}
                    className={cn(
                      SELECTOR_MENU_ITEM_CLASS_NAME,
                      "w-full",
                      busy && "cursor-wait opacity-60",
                    )}
                  >
                    <div className="flex w-full items-center gap-1.5">
                      <BranchStatusIcon className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-left">{branch}</span>
                      {branch === (activeSelectedBranch ?? state.currentBranch)
                        ? <CheckmarkIcon className="shrink-0" />
                        : null}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {onCreate && (
            <>
              <div className={SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME}>
                <div className={SELECTOR_MENU_DIVIDER_CLASS_NAME} />
              </div>

              <button
                type="button"
                disabled={!canCreateBranch}
                onClick={() => void handleCreateClick()}
                className={cn(
                  SELECTOR_MENU_ITEM_CLASS_NAME,
                  "w-full",
                  !canCreateBranch && "cursor-default opacity-60",
                )}
              >
                <div className="flex w-full items-center gap-1.5">
                  <PlusIcon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">Create and checkout new branch…</span>
                </div>
              </button>
            </>
          )}
        </div>
      </SelectorPopoverContent>
    </PopoverPrimitive.Root>
  );
}
