import { useCallback, useMemo, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { CheckmarkIcon, ConfigStatusIcon } from "@/components/shared/icons";
import type { WorktreeEnvironmentOption } from "@/lib/types";
import { cn } from "@/lib/utils";
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

interface EnvironmentSelectorPopoverProps {
  options: WorktreeEnvironmentOption[];
  selectedPath?: string | null;
  busy: boolean;
  onRefresh: () => Promise<unknown>;
  onSelect: (environmentPath: string | null) => Promise<boolean> | boolean;
  onOpenSettings: () => Promise<void> | void;
  disabled?: boolean;
  triggerClassName?: string;
}

export function EnvironmentSelectorPopover({
  options,
  selectedPath,
  busy,
  onRefresh,
  onSelect,
  onOpenSettings,
  disabled = false,
  triggerClassName,
}: EnvironmentSelectorPopoverProps) {
  const [open, setOpen] = useState(false);
  const normalizedSelectedPath = selectedPath?.trim() || "";

  const selectedOption = useMemo(
    () => options.find((option) => option.path === normalizedSelectedPath),
    [options, normalizedSelectedPath],
  );

  const triggerLabel = selectedOption?.name ?? "No environment";
  const isDisabled = disabled || busy;

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    void onRefresh();
  }, [onRefresh]);

  const handleSelect = useCallback(async (environmentPath: string | null) => {
    const applied = await onSelect(environmentPath);
    if (!applied) return;
    setOpen(false);
  }, [onSelect]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <SelectorPopoverTrigger
        ariaLabel="Select worktree environment"
        title={triggerLabel}
        label={triggerLabel}
        icon={<ConfigStatusIcon className="size-3.5 shrink-0" />}
        disabled={isDisabled}
        className={triggerClassName}
      />

      <SelectorPopoverContent className="min-w-65">
        <div className={cn(SELECTOR_MENU_PANEL_CLASS_NAME, "w-full")}>
          <div className={SELECTOR_MENU_TITLE_CLASS_NAME}>Select environment</div>
          <div className={cn(SELECTOR_MENU_LIST_CLASS_NAME, "max-h-55 pr-1 pb-1")}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSelect(null)}
              className={cn(
                SELECTOR_MENU_ITEM_CLASS_NAME,
                "w-full",
                busy && "cursor-wait opacity-60",
              )}
            >
              <div className="flex w-full items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-left">No environment</span>
                {normalizedSelectedPath.length === 0 ? <CheckmarkIcon className="shrink-0" /> : null}
              </div>
            </button>

            {options.map((option) => (
              <button
                key={option.path}
                type="button"
                disabled={busy}
                onClick={() => void handleSelect(option.path)}
                className={cn(
                  SELECTOR_MENU_ITEM_CLASS_NAME,
                  "w-full",
                  busy && "cursor-wait opacity-60",
                )}
              >
                <div className="flex w-full items-center gap-1.5">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="min-w-0 truncate text-left">{option.name}</span>
                    {option.hasSetupScript ? (
                      <span className="shrink-0 rounded-sm bg-(--blue-bg) px-1 text-xs text-(--blue-text)">
                        setup
                      </span>
                    ) : null}
                  </div>
                  {option.path === normalizedSelectedPath ? <CheckmarkIcon className="shrink-0" /> : null}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className={SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME}>
          <div className={SELECTOR_MENU_DIVIDER_CLASS_NAME} />
        </div>

        <button
          type="button"
          onClick={() => {
            void onOpenSettings();
            setOpen(false);
          }}
          className={cn(
            SELECTOR_MENU_ITEM_CLASS_NAME,
            "w-full",
          )}
        >
          <div className="flex w-full items-center gap-1.5">
            <ConfigStatusIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">Environment settings</span>
          </div>
        </button>
      </SelectorPopoverContent>
    </PopoverPrimitive.Root>
  );
}
