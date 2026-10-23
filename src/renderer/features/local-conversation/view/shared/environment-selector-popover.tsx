import { createPortal } from "react-dom";
import {
  COMPOSER_PICKER_ITEM_CLASS_NAME,
  handleInlineComposerPickerKeyDown,
  handleComposerPickerSearchKeyDown,
  type InlineComposerPickerPresentation,
} from "./inline-composer-picker";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Star } from "@/components/shared/icons/generic-icons";
import { ActivitySpinnerIcon, CheckmarkIcon, ConfigStatusIcon } from "@/components/shared/icons";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMessage,
  NodexDropdownMenu,
  NodexDropdownSection,
  NodexDropdownTitle,
  NodexDropdownSearchInput,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { WorktreeEnvironmentConfigRecord, WorktreeEnvironmentOption } from "@/lib/types";
import { cn } from "@/lib/utils";

interface EnvironmentSelectorPopoverProps {
  inline?: InlineComposerPickerPresentation;
  configs?: WorktreeEnvironmentConfigRecord[];
  options?: WorktreeEnvironmentOption[];
  selectedPath?: string | null;
  defaultPath?: string | null;
  repairConfigPath?: string | null;
  needsAttention?: boolean;
  busy: boolean;
  error?: boolean;
  onRefresh: () => Promise<unknown>;
  onSelect: (environmentPath: string | null) => Promise<boolean> | boolean;
  onOpenSettings: (configPath?: string | null) => Promise<void> | void;
  disabled?: boolean;
  triggerClassName?: string;
  repositoryName?: string | null;
  showRepositoryName?: boolean;
  defaultOpen?: boolean;
}

function pathEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return (
    left.replaceAll("\\", "/").replace(/\/+$/, "") ===
    right.replaceAll("\\", "/").replace(/\/+$/, "")
  );
}

export function resolveEnvironmentSelectorLabel({
  configs,
  selectedPath,
  busy,
  error,
  needsAttention,
}: {
  configs: readonly WorktreeEnvironmentConfigRecord[];
  selectedPath?: string | null;
  busy: boolean;
  error: boolean;
  needsAttention: boolean;
}): string {
  if (busy) return "Loading environments…";
  if (error || needsAttention) return "Needs attention";
  const selected = configs.find(
    (config) => config.state === "success" && pathEquals(config.configPath, selectedPath),
  );
  return (
    selected?.name ?? (selectedPath?.trim() ? "Selected environment unavailable" : "No environment")
  );
}

export function EnvironmentSelectorPopover({
  inline,
  configs,
  options,
  selectedPath,
  defaultPath,
  repairConfigPath,
  needsAttention = false,
  busy,
  error = false,
  onRefresh,
  onSelect,
  onOpenSettings,
  disabled = false,
  triggerClassName,
  repositoryName,
  showRepositoryName = false,
  defaultOpen = false,
}: EnvironmentSelectorPopoverProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = inline?.open ?? localOpen;
  const setOpen = inline?.onOpenChange ?? setLocalOpen;
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);
  const normalizedSelectedPath = selectedPath?.trim() || "";
  const resolvedConfigs = useMemo<WorktreeEnvironmentConfigRecord[]>(
    () =>
      configs ??
      options?.map((option) => ({
        configPath: option.path,
        fileName: option.path.split(/[\\/]/).at(-1) ?? option.name,
        state: "success",
        exists: true,
        name: option.name,
        hasSetupScript: option.hasSetupScript,
        hasCleanupScript: option.hasCleanupScript,
        actionCount: option.actionCount,
        parseErrorMessage: null,
        readErrorMessage: null,
        tooLargeMessage: null,
        environment: null,
      })) ??
      [],
    [configs, options],
  );
  const successfulConfigs = useMemo(
    () => resolvedConfigs.filter((config) => config.state === "success"),
    [resolvedConfigs],
  );
  const defaultConfig =
    successfulConfigs.find((config) => pathEquals(config.configPath, defaultPath)) ?? null;
  const remainingConfigs = defaultConfig
    ? successfulConfigs.filter((config) => config.configPath !== defaultConfig.configPath)
    : successfulConfigs;
  const matchesSearch = (config: WorktreeEnvironmentConfigRecord) =>
    config.name?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const listedConfigs = remainingConfigs.filter(matchesSearch);
  const visibleDefaultConfig = defaultConfig && matchesSearch(defaultConfig) ? defaultConfig : null;
  const triggerLabel = resolveEnvironmentSelectorLabel({
    configs: resolvedConfigs,
    selectedPath,
    busy,
    error,
    needsAttention,
  });
  const isDisabled = disabled;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) return;
      void onRefresh();
    },
    [onRefresh, setOpen],
  );

  const handleSelect = useCallback(
    async (environmentPath: string | null) => {
      const applied = await onSelect(environmentPath);
      if (!applied) return;
      setOpen(false);
    },
    [onSelect, setOpen],
  );

  const title =
    showRepositoryName && repositoryName?.trim()
      ? `Environment · ${repositoryName.trim()}`
      : "Environment";

  const pickerContent = (
    <div
      data-composer-picker="environment"
      className={cn("flex flex-col overflow-hidden", inline ? "w-full" : "w-64")}
      onKeyDownCapture={(event) => handleInlineComposerPickerKeyDown(event, inline)}
    >
      {!inline ? <NodexDropdownTitle>{title}</NodexDropdownTitle> : null}
      <NodexDropdownSearchInput
        autoFocus={Boolean(inline)}
        value={search}
        aria-label="Search environments"
        placeholder="Search environments…"
        onChange={(event) => setSearch(event.currentTarget.value)}
        onKeyDown={(event) => handleComposerPickerSearchKeyDown(event, busy || error)}
      />
      <NodexDropdownSeparator />
      <div className="vertical-scroll-fade-mask flex max-h-[220px] flex-col overflow-y-auto">
        {!busy && !error ? (
          <NodexDropdownItem
            data-composer-picker-option={!search.trim()}
            className={COMPOSER_PICKER_ITEM_CLASS_NAME}
            closeOnClick={false}
            onSelect={() => void handleSelect(null)}
            rightSlot={
              normalizedSelectedPath.length === 0 && !needsAttention ? (
                <CheckmarkIcon className="icon-xs shrink-0" />
              ) : null
            }
          >
            Work without environment
          </NodexDropdownItem>
        ) : null}

        {visibleDefaultConfig ? (
          <NodexDropdownItem
            data-composer-picker-option="true"
            className={COMPOSER_PICKER_ITEM_CLASS_NAME}
            closeOnClick={false}
            onSelect={() => void handleSelect(visibleDefaultConfig.configPath)}
            rightSlot={
              pathEquals(visibleDefaultConfig.configPath, normalizedSelectedPath) ? (
                <CheckmarkIcon className="icon-xs shrink-0" />
              ) : null
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <NodexTooltip tooltipContent="Default environment">
                <Star className="icon-xxs shrink-0 text-token-description-foreground" />
              </NodexTooltip>
              <span className="truncate">{visibleDefaultConfig.name}</span>
            </span>
          </NodexDropdownItem>
        ) : null}

        {busy ? (
          <div className="flex items-center justify-center py-4">
            <ActivitySpinnerIcon className="icon-xxs" />
          </div>
        ) : error ? (
          <NodexDropdownMessage compact tone="error">
            Error loading environments
          </NodexDropdownMessage>
        ) : listedConfigs.length > 0 ? (
          <NodexDropdownSection className="flex flex-col">
            {listedConfigs.map((config) => (
              <NodexDropdownItem
                data-composer-picker-option="true"
                className={COMPOSER_PICKER_ITEM_CLASS_NAME}
                closeOnClick={false}
                key={config.configPath}
                onSelect={() => void handleSelect(config.configPath)}
                rightSlot={
                  pathEquals(config.configPath, normalizedSelectedPath) ? (
                    <CheckmarkIcon className="icon-xs shrink-0" />
                  ) : null
                }
              >
                <span className="min-w-0 truncate">{config.name}</span>
              </NodexDropdownItem>
            ))}
          </NodexDropdownSection>
        ) : visibleDefaultConfig ? null : search.trim() ? (
          <NodexDropdownMessage compact>No environments found</NodexDropdownMessage>
        ) : resolvedConfigs.length > 0 && successfulConfigs.length === 0 ? (
          <NodexDropdownMessage compact tone="error">
            Needs attention
          </NodexDropdownMessage>
        ) : (
          <NodexDropdownMessage compact>No environments found</NodexDropdownMessage>
        )}

        <NodexDropdownItem
          className={COMPOSER_PICKER_ITEM_CLASS_NAME}
          closeOnClick={false}
          onSelect={() => {
            void onOpenSettings(repairConfigPath);
            setOpen(false);
          }}
          leftSlot={<ConfigStatusIcon className="icon-xs shrink-0" />}
        >
          {resolvedConfigs.length === 0 ? "Set up project" : "Environment settings"}
        </NodexDropdownItem>
      </div>
    </div>
  );

  if (inline) {
    return inline.open && inline.container ? createPortal(pickerContent, inline.container) : null;
  }

  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={handleOpenChange}
      side="top"
      align="start"
      disabled={isDisabled}
      triggerTooltipContent={triggerLabel}
      triggerButton={
        <NodexDropdownButtonTrigger
          aria-label="Select worktree environment"
          data-composer-navigation-target="environment"
          disabled={isDisabled}
          size="sm"
          chrome="transparent"
          shape="pill"
          muted
          className={cn("whitespace-nowrap px-1.5", triggerClassName)}
        >
          <span className="inline-flex min-w-0 items-center gap-1">
            <ConfigStatusIcon className="icon-xs shrink-0" />
            <span className="max-w-40 truncate text-sm">{triggerLabel}</span>
          </span>
        </NodexDropdownButtonTrigger>
      }
    >
      {pickerContent}
    </NodexDropdownMenu>
  );
}
