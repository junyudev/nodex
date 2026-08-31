import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AutomationActiveStatusIcon,
  AutomationArchiveIcon,
  DeleteIcon,
  EditIcon,
  AutomationLoadingIcon,
  AutomationMoreIcon,
  AutomationPauseIcon,
  AutomationResumeIcon,
  AutomationRunNowIcon,
  AutomationTemplateColorIcon,
  AutomationsIcon,
  CompactChevronDownIcon,
  PanelRightVisibleIcon,
  SettingsSearchIcon,
  SidePanelPlusIcon,
  SidePanelSideChatIcon,
  SidebarSortClockIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  NodexOptionPicker,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
  NodexDropdownSeparator,
  NodexDropdownSelectedIcon,
  NodexDropdownTitle,
} from "@/components/ui/dropdown";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import {
  NodexPopover,
  NodexPopoverContent,
  NodexPopoverTitle,
  NodexPopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  archiveCodexAutomationRun,
  createCodexScheduledAutomation,
  deleteCodexScheduledAutomation,
  runCodexScheduledAutomationNow,
  setCodexAutomationRunReadState,
  unarchiveCodexAutomationRun,
  updateCodexScheduledAutomation,
} from "@/lib/codex-automation-runtime";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
  getVisibleCodexModels,
  resolveCodexReasoningEffortOptions,
} from "@/lib/codex-thread-settings";
import {
  formatCodexScheduledAutomationNextRunLabel,
  sortCodexScheduledAutomationsForDisplay,
} from "@/lib/codex-scheduled-automation-display";
import { codexModelsListQueryOptions } from "@/lib/query-options";
import { queryKeys } from "@/lib/query-keys";
import { useCodexAutomationRunsInbox } from "@/lib/use-codex-automation-runs-inbox";
import { useCodexScheduledAutomations } from "@/lib/use-codex-scheduled-automations";
import { useLocalEnvironmentOptions } from "@/lib/use-local-environment-queries";
import type {
  CodexScheduledAutomation,
  CodexModelOption,
  CodexScheduledAutomationReasoningEffort,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationUpdateInput,
  Project,
  WorktreeEnvironmentOption,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  buildCodexScheduledAutomationCreateInput,
  buildCodexScheduledAutomationUpdateInput,
  cloneWorkbenchAutomationDraft,
  createWorkbenchAutomationDraft,
  createWorkbenchAutomationDraftFromCreateInput,
  createWorkbenchAutomationDraftFromUpdateInput,
  DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT,
  formatWorkbenchAutomationDraftSaveTooltip,
  hasWorkbenchAutomationCreateDraftChanges,
  isWorkbenchAutomationDraftDirty,
  resolveWorkbenchAutomationDraftModelSettings,
  validateWorkbenchAutomationDraft,
  type WorkbenchAutomationDraft,
  type WorkbenchAutomationDraftValidation,
} from "./workbench-automation-draft";
import {
  buildWorkbenchAutomationScheduleRrule,
  formatWorkbenchAutomationScheduleLabel,
  formatWorkbenchAutomationScheduleModeLabel,
  resolveWorkbenchAutomationScheduleConfig,
  updateWorkbenchAutomationScheduleConfig,
  type WorkbenchAutomationScheduleConfig,
  type WorkbenchAutomationScheduleIntervalStyle,
  type WorkbenchAutomationScheduleMode,
  type WorkbenchAutomationWeekdayCode,
} from "./workbench-automation-schedule";
import {
  buildWorkbenchAutomationProjectOptions,
  formatWorkbenchAutomationProjectTriggerLabel,
  resolveWorkbenchAutomationProjectForRoot,
  toggleWorkbenchAutomationProjectRoot,
} from "./workbench-automation-project-options";
import {
  WORKBENCH_AUTOMATION_CREATE_WITH_CHAT_PROMPT,
  WORKBENCH_AUTOMATION_FIRST_RUN_SUGGESTIONS,
  WORKBENCH_AUTOMATION_TEMPLATES,
  buildWorkbenchAutomationTemplatePersonalizationPrompt,
  createWorkbenchAutomationDraftFromTemplate,
  filterWorkbenchAutomationTemplates,
  type WorkbenchAutomationFirstRunSuggestion,
  type WorkbenchAutomationTemplate,
} from "./workbench-automation-templates";
import {
  buildWorkbenchAutomationListModel,
  type WorkbenchAutomationRowModel,
} from "./workbench-automation-list";
import {
  buildWorkbenchAutomationPreviousRunRows,
  type WorkbenchAutomationPreviousRunRowModel,
} from "./workbench-automation-runs";
import {
  buildAutomationsPath,
  resolveAutomationsRouteState,
  type WorkbenchAutomationsTab,
} from "./workbench-automations-routes";
import { AppShellHeaderContentRegistrar } from "@/lib/workbench-ui-scopes";

interface WorkbenchAutomationsRouteShellProps {
  path: string;
  projects?: readonly Project[];
  externalHeader?: boolean;
  detailRailPortalTarget?: HTMLElement | null;
  onDetailRailOpenChange?: (open: boolean) => void;
  onPathChange: (path: string) => void;
  onOpenThread?: (threadId: string) => Promise<void | boolean> | void | boolean;
  onCreateWithChat?: (prompt: string) => Promise<void> | void;
  onPersonalizeTemplate?: (prompt: string) => Promise<void> | void;
  onOpenLocalEnvironmentsSettings?: (input: {
    projectId: string | null;
    configPath: string | null;
  }) => void;
}

const EMPTY_AUTOMATION_PROJECTS: readonly Project[] = [];

function formatAutomationStatus(status: CodexScheduledAutomation["status"]): string {
  if (status === "ACTIVE") return "Active";
  if (status === "PAUSED") return "Paused";
  return "Deleted";
}

function formatAutomationTimestamp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function upsertAutomationInList(
  automations: CodexScheduledAutomation[] | undefined,
  automation: CodexScheduledAutomation,
): CodexScheduledAutomation[] {
  if (!automations) return [automation];
  const didReplace = automations.some((item) => item.id === automation.id);
  if (didReplace) {
    return automations.map((item) => (item.id === automation.id ? automation : item));
  }
  return [...automations, automation];
}

function deleteAutomationFromList(
  automations: CodexScheduledAutomation[] | undefined,
  automationId: string,
): CodexScheduledAutomation[] {
  return (automations ?? []).filter((automation) => automation.id !== automationId);
}

function getAutomationErrorDescription(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message.trim();
  return message.length > 0 ? message : undefined;
}

function showAutomationMutationErrorToast(title: string, error: unknown): string | undefined {
  const description = getAutomationErrorDescription(error);
  toast.danger(title, { description });
  return description;
}

function applyOptimisticAutomationUpdate(
  automations: CodexScheduledAutomation[] | undefined,
  update: CodexScheduledAutomationUpdateInput,
): CodexScheduledAutomation[] | undefined {
  if (!automations) return automations;
  return automations.map((automation) => {
    if (automation.id !== update.id) return automation;
    const isCron = update.kind === "cron";
    return {
      ...automation,
      id: update.id,
      kind: update.kind,
      status: update.status,
      targetThreadId: isCron ? null : (update.targetThreadId ?? null),
      name: update.name,
      prompt: update.prompt ?? "",
      rrule: update.rrule ?? null,
      model: isCron ? (update.model ?? null) : null,
      reasoningEffort: isCron ? (update.reasoningEffort ?? null) : null,
      cwds: isCron ? [...(update.cwds ?? [])] : [],
      executionEnvironment: isCron
        ? (update.executionEnvironment ?? automation.executionEnvironment)
        : "worktree",
      localEnvironmentConfigPath: isCron
        ? update.localEnvironmentConfigPath === undefined
          ? automation.localEnvironmentConfigPath
          : update.localEnvironmentConfigPath
        : null,
      nextRunAt: update.status === "PAUSED" ? null : automation.nextRunAt,
      lastRunAt: automation.lastRunAt,
      createdAt: automation.createdAt,
      updatedAt: automation.updatedAt,
    };
  });
}

function buildAutomationStatusUpdateInput(
  automation: CodexScheduledAutomation,
  status: CodexScheduledAutomation["status"],
): CodexScheduledAutomationUpdateInput {
  return {
    id: automation.id,
    kind: automation.kind,
    status,
    targetThreadId: automation.targetThreadId,
    name: automation.name,
    prompt: automation.prompt,
    rrule: automation.rrule,
    model: automation.model,
    reasoningEffort: automation.reasoningEffort,
    cwds: automation.cwds,
    executionEnvironment: automation.executionEnvironment,
    localEnvironmentConfigPath: automation.localEnvironmentConfigPath,
  };
}

function areAutomationUpdateInputsEqual(
  left: CodexScheduledAutomationUpdateInput | null | undefined,
  right: CodexScheduledAutomationUpdateInput | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

const AUTOMATION_FIELD_TRIGGER_CLASS =
  "border-token-border no-drag flex h-7 min-w-0 items-center gap-1 whitespace-nowrap rounded-full border border-transparent bg-transparent px-1.5 py-0 text-base leading-[18px] text-token-text-tertiary outline-hidden select-none enabled:cursor-interaction enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40";
const AUTOMATION_FIELD_INPUT_CLASS =
  "h-7 w-full min-w-0 rounded-full border border-transparent bg-transparent px-1.5 text-right text-base leading-[18px] text-token-text-primary outline-none hover:bg-token-list-hover-background focus:border-token-focus-border disabled:cursor-not-allowed disabled:opacity-40";
const AUTOMATION_SCHEDULE_INPUT_CLASS =
  "bg-token-input-background text-token-input-foreground placeholder:text-token-input-placeholder-foreground w-full rounded-md border border-token-input-border px-2.5 py-1.5 text-base outline-none focus:border-token-focus-border disabled:cursor-not-allowed disabled:opacity-50";
const AUTOMATION_TEXTAREA_CLASS =
  "min-h-28 w-full resize-none rounded-lg border border-token-input-border bg-token-input-background px-3 py-2 text-base leading-6 text-token-input-foreground outline-none placeholder:text-token-text-tertiary focus:border-token-focus-border disabled:cursor-not-allowed disabled:opacity-50";
const AUTOMATION_TOOLBAR_BUTTON_BASE_CLASS =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg h-token-button-composer px-2 py-0 text-base leading-[18px]";
const AUTOMATION_TOOLBAR_BUTTON_GHOST_CLASS =
  "text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent";
const AUTOMATION_TOOLBAR_BUTTON_SECONDARY_CLASS =
  "text-token-foreground bg-token-foreground/5 enabled:hover:bg-token-foreground/10 data-[state=open]:bg-token-foreground/10 border-transparent";
const AUTOMATION_TOOLBAR_BUTTON_PRIMARY_CLASS =
  "bg-token-foreground enabled:hover:bg-token-foreground/80 data-[state=open]:bg-token-foreground/80 text-token-dropdown-background border-transparent";
const AUTOMATION_TOOLBAR_BUTTON_OUTLINE_CLASS =
  "border-token-border text-token-button-tertiary-foreground bg-token-bg-fog enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border";

function resolveDraftRunInTarget(draft: WorkbenchAutomationDraft): "local" | "worktree" | "thread" {
  return draft.kind === "heartbeat" ? "thread" : draft.executionEnvironment;
}

function runInTargetLabel(target: "local" | "worktree" | "thread"): string {
  if (target === "thread") return "Chat";
  if (target === "local") return "Local";
  return "Worktree";
}

function AutomationDropdownField({
  ariaLabel,
  title,
  value,
  options,
  disabled = false,
  triggerClassName,
  onValueChange,
}: {
  ariaLabel: string;
  title: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  triggerClassName?: string;
  onValueChange: (value: string) => void;
}) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  return (
    <NodexOptionPicker
      value={value}
      options={options}
      onValueChange={onValueChange}
      title={title}
      align="end"
      side="bottom"
      contentWidth="sm"
      disabled={disabled}
      triggerButton={
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            AUTOMATION_FIELD_TRIGGER_CLASS,
            "inline-flex max-w-full justify-end",
            triggerClassName,
          )}
        >
          <span className="min-w-0 truncate text-token-foreground">{selectedLabel}</span>
          <CompactChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
        </button>
      }
    />
  );
}

const AUTOMATION_SCHEDULE_TIME_PICKER_VALUES = Array.from({ length: 96 }, (_, index) => {
  const minutes = index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});
const AUTOMATION_WEEKDAY_LABELS: Record<WorkbenchAutomationWeekdayCode, string> = {
  SU: "Sunday",
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
};

function buildScheduleModeOptions(intervalStyle: WorkbenchAutomationScheduleIntervalStyle): Array<{
  value: WorkbenchAutomationScheduleMode;
  label: string;
}> {
  return (
    ["hourly", "daily", "weekdays", "weekly", "custom"] as WorkbenchAutomationScheduleMode[]
  ).map((mode) => ({
    value: mode,
    label: formatWorkbenchAutomationScheduleModeLabel({ mode, intervalStyle }),
  }));
}

function formatScheduleTimePickerLabel(value: string): string {
  const [rawHour, rawMinute] = value.split(":");
  const hour = Number.parseInt(rawHour ?? "", 10);
  const minute = Number.parseInt(rawMinute ?? "", 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return value;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2024, 0, 1, hour, minute));
}

function schedulePopoverWidthClass(
  config: WorkbenchAutomationScheduleConfig,
  intervalStyle: WorkbenchAutomationScheduleIntervalStyle,
): string {
  if (config.mode === "custom") return "!w-96 min-w-96";
  if (intervalStyle === "heartbeat") return "!w-56 min-w-56";
  return "!w-40 min-w-40";
}

function AutomationSchedulePopover({
  rrule,
  intervalStyle,
  disabled,
  onRruleChange,
}: {
  rrule: string;
  intervalStyle: WorkbenchAutomationScheduleIntervalStyle;
  disabled: boolean;
  onRruleChange: (rrule: string) => void;
}) {
  const [forcedCustomRrule, setForcedCustomRrule] = useState<string | null>(null);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const resolvedConfig = useMemo(() => {
    const config = resolveWorkbenchAutomationScheduleConfig({ rrule, intervalStyle });
    if (forcedCustomRrule !== null && forcedCustomRrule === rrule) {
      return {
        ...config,
        mode: "custom" as const,
        customRrule: rrule,
      };
    }
    return config;
  }, [forcedCustomRrule, intervalStyle, rrule]);
  const selectedLabel = formatWorkbenchAutomationScheduleLabel(resolvedConfig);
  const modeOptions = useMemo(() => buildScheduleModeOptions(intervalStyle), [intervalStyle]);
  const updateSchedule = (patch: Partial<WorkbenchAutomationScheduleConfig>) => {
    const nextConfig = updateWorkbenchAutomationScheduleConfig({
      config: resolvedConfig,
      patch,
      intervalStyle,
    });
    const nextRrule = buildWorkbenchAutomationScheduleRrule({
      config: nextConfig,
      intervalStyle,
    });
    setForcedCustomRrule(nextConfig.mode === "custom" ? nextRrule : null);
    onRruleChange(nextRrule);
  };
  const hasTimeInput =
    resolvedConfig.mode === "daily" ||
    resolvedConfig.mode === "weekdays" ||
    resolvedConfig.mode === "weekly";
  const intervalValue = String(resolvedConfig.intervalMinutes ?? 30);
  const intervalSuffix = resolvedConfig.intervalMinutes === 1 ? "minute" : "minutes";

  return (
    <NodexPopover
      onOpenChange={(open) => {
        if (!open) setTimePickerOpen(false);
      }}
    >
      <NodexPopoverTrigger>
        <button
          type="button"
          aria-label="Schedule"
          disabled={disabled}
          className={cn(AUTOMATION_FIELD_TRIGGER_CLASS, "inline-flex max-w-full justify-end")}
        >
          <span className="min-w-0 truncate text-token-foreground">{selectedLabel}</span>
          <CompactChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
        </button>
      </NodexPopoverTrigger>
      {disabled ? null : (
        <NodexPopoverContent
          align="end"
          side="bottom"
          className={cn("gap-1", schedulePopoverWidthClass(resolvedConfig, intervalStyle))}
        >
          <div className="flex w-full flex-col gap-1">
            <NodexPopoverTitle className="text-token-description-foreground flex min-h-6 items-center truncate px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm leading-4">
              Schedule
            </NodexPopoverTitle>
            <NodexOptionPicker
              value={resolvedConfig.mode}
              options={modeOptions}
              onValueChange={(value) =>
                updateSchedule({ mode: value as WorkbenchAutomationScheduleMode })
              }
              title="Schedule type"
              align="end"
              side="bottom"
              contentWidth="sm"
              triggerButton={
                <button
                  type="button"
                  aria-label="Schedule type"
                  className={cn(AUTOMATION_FIELD_TRIGGER_CLASS, "w-full justify-between text-sm")}
                >
                  <span className="min-w-0 truncate text-token-foreground">
                    {formatWorkbenchAutomationScheduleModeLabel({
                      mode: resolvedConfig.mode,
                      intervalStyle,
                    })}
                  </span>
                  <CompactChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
                </button>
              }
            />

            {resolvedConfig.mode === "hourly" && intervalStyle === "heartbeat" ? (
              <label className="text-token-secondary flex items-center gap-2 px-[var(--padding-row-x)] text-sm">
                <span className="shrink-0">Every</span>
                <input
                  aria-label="Interval minutes"
                  className={cn(AUTOMATION_SCHEDULE_INPUT_CLASS, "w-20 text-sm")}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  type="text"
                  defaultValue={intervalValue}
                  onChange={(event) => {
                    const digits = event.currentTarget.value.replaceAll(/[^0-9]/gu, "");
                    event.currentTarget.value = digits;
                    if (digits.length === 0) return;
                    updateSchedule({ intervalMinutes: Number.parseInt(digits, 10) });
                  }}
                  onBlur={(event) => {
                    if (event.currentTarget.value.length === 0)
                      event.currentTarget.value = intervalValue;
                  }}
                />
                <span className="shrink-0">{intervalSuffix}</span>
              </label>
            ) : null}

            {resolvedConfig.mode === "weekly" ? (
              <NodexOptionPicker
                value={resolvedConfig.weekdays[0] ?? "MO"}
                options={[
                  { value: "SU", label: "Sunday" },
                  { value: "MO", label: "Monday" },
                  { value: "TU", label: "Tuesday" },
                  { value: "WE", label: "Wednesday" },
                  { value: "TH", label: "Thursday" },
                  { value: "FR", label: "Friday" },
                  { value: "SA", label: "Saturday" },
                ]}
                onValueChange={(value) =>
                  updateSchedule({ weekdays: [value as WorkbenchAutomationWeekdayCode] })
                }
                title="Day"
                align="end"
                side="bottom"
                contentWidth="sm"
                triggerButton={
                  <button
                    type="button"
                    aria-label="Day"
                    className={cn(AUTOMATION_FIELD_TRIGGER_CLASS, "w-full justify-between text-sm")}
                  >
                    <span className="min-w-0 truncate text-token-foreground">
                      {AUTOMATION_WEEKDAY_LABELS[resolvedConfig.weekdays[0] ?? "MO"]}
                    </span>
                    <CompactChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
                  </button>
                }
              />
            ) : null}

            {hasTimeInput ? (
              <div className="flex w-full flex-col gap-1">
                <div className="relative w-full">
                  <input
                    aria-label="Time"
                    className={cn(
                      AUTOMATION_SCHEDULE_INPUT_CLASS,
                      "w-full !pr-8 text-sm [&::-webkit-calendar-picker-indicator]:hidden",
                    )}
                    type="time"
                    value={resolvedConfig.time}
                    onInput={(event) => updateSchedule({ time: event.currentTarget.value })}
                    onChange={(event) => updateSchedule({ time: event.currentTarget.value })}
                  />
                  <NodexButton
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={timePickerOpen ? "Hide time picker" : "Show time picker"}
                    aria-expanded={timePickerOpen}
                    className={cn(
                      "absolute top-1/2 right-[5px] -translate-y-1/2",
                      timePickerOpen && "bg-token-list-hover-background",
                    )}
                    onClick={() => setTimePickerOpen((open) => !open)}
                  >
                    <SidebarSortClockIcon className="icon-2xs" />
                  </NodexButton>
                </div>
                {timePickerOpen ? (
                  <div
                    className="overflow-y-scroll overscroll-contain rounded-lg border border-token-border bg-token-input-background/70 p-1"
                    style={{
                      maxHeight:
                        "min(14rem, max(3.5rem, calc(var(--nodex-floating-surface-available-height) - 9rem)))",
                    }}
                    onWheel={(event) => event.stopPropagation()}
                  >
                    {AUTOMATION_SCHEDULE_TIME_PICKER_VALUES.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={`Set time to ${formatScheduleTimePickerLabel(value)}`}
                        aria-pressed={value === resolvedConfig.time}
                        className={cn(
                          "cursor-interaction flex h-7 w-full items-center rounded-md px-2 text-left text-sm tabular-nums outline-none focus:bg-token-list-hover-background",
                          value === resolvedConfig.time
                            ? "bg-token-list-hover-background text-token-foreground"
                            : "text-token-secondary hover:bg-token-list-hover-background",
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          updateSchedule({ time: value });
                          setTimePickerOpen(false);
                        }}
                      >
                        {formatScheduleTimePickerLabel(value)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {resolvedConfig.mode === "custom" ? (
              <input
                aria-label="Custom RRULE"
                className={cn(AUTOMATION_SCHEDULE_INPUT_CLASS, "w-full text-sm font-mono")}
                placeholder="RRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0"
                spellCheck={false}
                value={resolvedConfig.customRrule}
                onInput={(event) => updateSchedule({ customRrule: event.currentTarget.value })}
                onChange={(event) => updateSchedule({ customRrule: event.currentTarget.value })}
              />
            ) : null}
          </div>
        </NodexPopoverContent>
      )}
    </NodexPopover>
  );
}

function AutomationProjectDropdown({
  projects,
  selectedRoots,
  disabled,
  onSelectedRootsChange,
}: {
  projects: readonly Project[];
  selectedRoots: readonly string[];
  disabled: boolean;
  onSelectedRootsChange: (roots: string[]) => void;
}) {
  const options = useMemo(
    () => buildWorkbenchAutomationProjectOptions({ projects, selectedRoots }),
    [projects, selectedRoots],
  );
  const selectedRootSet = useMemo(() => new Set(selectedRoots), [selectedRoots]);
  const triggerLabel = formatWorkbenchAutomationProjectTriggerLabel({ selectedRoots, options });
  const hasSelection = selectedRoots.length > 0;

  return (
    <NodexDropdownMenu
      align="end"
      side="bottom"
      contentWidth="workspace"
      contentMaxHeight="tall"
      disabled={disabled}
      triggerButton={
        <button
          type="button"
          aria-label="Project"
          disabled={disabled}
          className={cn(
            AUTOMATION_FIELD_TRIGGER_CLASS,
            "inline-flex w-auto max-w-full justify-end",
            !hasSelection && "text-token-text-tertiary",
          )}
        >
          <span className="min-w-0 truncate text-token-foreground">{triggerLabel}</span>
          <CompactChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
        </button>
      }
    >
      <NodexDropdownTitle>Project</NodexDropdownTitle>
      {options.length === 0 ? (
        <NodexDropdownMessage compact>No project folders available</NodexDropdownMessage>
      ) : (
        options.map((option) => {
          const selected = selectedRootSet.has(option.value);
          return (
            <NodexDropdownItem
              key={option.value}
              subText={option.description}
              rightSlot={selected ? <NodexDropdownSelectedIcon /> : null}
              tooltipText={
                option.isFallback
                  ? "This saved folder is not in the current project list."
                  : undefined
              }
              onSelect={(event) => {
                event.preventDefault();
                onSelectedRootsChange(
                  toggleWorkbenchAutomationProjectRoot({
                    selectedRoots,
                    root: option.value,
                  }),
                );
              }}
            >
              {option.label}
            </NodexDropdownItem>
          );
        })
      )}
    </NodexDropdownMenu>
  );
}

const DEFAULT_LOCAL_ENVIRONMENT_FILE_NAME = "environment.toml";

function normalizeAutomationEnvironmentPath(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function localEnvironmentPathFileName(value: string): string {
  const normalizedPath = normalizeAutomationEnvironmentPath(value);
  const parts = normalizedPath.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? normalizedPath;
}

function localEnvironmentOptionLabel(option: WorktreeEnvironmentOption): string {
  const name = option.name.trim();
  if (name.length > 0) return name;
  return localEnvironmentPathFileName(option.path);
}

function resolveDefaultAutomationEnvironmentOption(
  options: readonly WorktreeEnvironmentOption[],
): WorktreeEnvironmentOption | null {
  return (
    options.find(
      (option) => localEnvironmentPathFileName(option.path) === DEFAULT_LOCAL_ENVIRONMENT_FILE_NAME,
    ) ??
    options[0] ??
    null
  );
}

function AutomationEnvironmentDropdown({
  projects,
  selectedRoot,
  selectedConfigPath,
  disabled,
  onSelectedConfigPathChange,
  onOpenSettings,
}: {
  projects: readonly Project[];
  selectedRoot: string;
  selectedConfigPath: string;
  disabled: boolean;
  onSelectedConfigPathChange: (configPath: string) => void;
  onOpenSettings?: (input: { projectId: string | null; configPath: string | null }) => void;
}) {
  const project = useMemo(
    () => resolveWorkbenchAutomationProjectForRoot({ projects, root: selectedRoot }),
    [projects, selectedRoot],
  );
  const projectId = project?.id ?? "";
  const environmentsQuery = useLocalEnvironmentOptions(projectId, {
    enabled: project !== null,
  });
  const environments = environmentsQuery.data ?? [];
  const normalizedSelectedPath = normalizeAutomationEnvironmentPath(selectedConfigPath);
  const selectedEnvironment =
    environments.find(
      (environment) =>
        normalizeAutomationEnvironmentPath(environment.path) === normalizedSelectedPath,
    ) ?? null;
  const defaultEnvironment = resolveDefaultAutomationEnvironmentOption(environments);
  const defaultEnvironmentPath = defaultEnvironment
    ? normalizeAutomationEnvironmentPath(defaultEnvironment.path)
    : "";
  const otherEnvironments = defaultEnvironment
    ? environments.filter(
        (environment) =>
          normalizeAutomationEnvironmentPath(environment.path) !== defaultEnvironmentPath,
      )
    : environments;
  const isLoading = project !== null && environmentsQuery.isLoading;
  const hasError = environmentsQuery.isError;
  const canShowChoices = !isLoading && !hasError;
  const triggerLabel = isLoading
    ? "Loading environments..."
    : selectedEnvironment
      ? localEnvironmentOptionLabel(selectedEnvironment)
      : "No environment";

  const openSettings = () => {
    onOpenSettings?.({
      projectId: project?.id ?? null,
      configPath: normalizedSelectedPath.length > 0 ? normalizedSelectedPath : null,
    });
  };

  return (
    <NodexDropdownMenu
      align="end"
      side="bottom"
      contentClassName="w-64"
      disabled={disabled}
      triggerButton={
        <button
          type="button"
          aria-label="Environment"
          disabled={disabled}
          className={cn(
            AUTOMATION_FIELD_TRIGGER_CLASS,
            "inline-flex w-auto max-w-full justify-end",
            selectedEnvironment === null && "text-token-text-tertiary",
          )}
        >
          <span className="min-w-0 truncate text-token-foreground">{triggerLabel}</span>
          {isLoading ? (
            <AutomationLoadingIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
          ) : (
            <CompactChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
          )}
        </button>
      }
    >
      <NodexDropdownTitle>Local environment</NodexDropdownTitle>
      <div className="vertical-scroll-fade-mask flex max-h-[220px] flex-col overflow-y-auto">
        {canShowChoices ? (
          <NodexDropdownItem
            rightSlot={normalizedSelectedPath.length === 0 ? <NodexDropdownSelectedIcon /> : null}
            onSelect={() => onSelectedConfigPathChange("")}
          >
            No environment
          </NodexDropdownItem>
        ) : null}
        {canShowChoices && defaultEnvironment ? (
          <NodexDropdownItem
            leftSlot={
              <NodexTooltip tooltipContent="Default environment">
                <span>
                  <AutomationTemplateColorIcon iconName="star-app" className="icon-xxs shrink-0" />
                </span>
              </NodexTooltip>
            }
            rightSlot={
              normalizedSelectedPath.length > 0 &&
              defaultEnvironmentPath === normalizedSelectedPath ? (
                <NodexDropdownSelectedIcon />
              ) : null
            }
            onSelect={() => onSelectedConfigPathChange(defaultEnvironment.path)}
          >
            {localEnvironmentOptionLabel(defaultEnvironment)}
          </NodexDropdownItem>
        ) : null}
        {canShowChoices && otherEnvironments.length > 0 ? (
          <div className="flex flex-col">
            {otherEnvironments.map((environment) => {
              const environmentPath = normalizeAutomationEnvironmentPath(environment.path);
              return (
                <NodexDropdownItem
                  key={environment.path}
                  rightSlot={
                    normalizedSelectedPath.length > 0 &&
                    environmentPath === normalizedSelectedPath ? (
                      <NodexDropdownSelectedIcon />
                    ) : null
                  }
                  onSelect={() => onSelectedConfigPathChange(environment.path)}
                >
                  {localEnvironmentOptionLabel(environment)}
                </NodexDropdownItem>
              );
            })}
          </div>
        ) : null}
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <AutomationLoadingIcon className="icon-xxs text-token-description-foreground" />
          </div>
        ) : hasError ? (
          <NodexDropdownMessage compact tone="error">
            Error loading environments
          </NodexDropdownMessage>
        ) : environments.length === 0 ? (
          <NodexDropdownMessage compact>No environments found</NodexDropdownMessage>
        ) : null}
      </div>
      <NodexDropdownSeparator />
      <div className="flex flex-col pb-1">
        <NodexDropdownItem
          leftSlot={<SidePanelPlusIcon className="icon-2xs shrink-0" />}
          onSelect={openSettings}
        >
          Create local environment
        </NodexDropdownItem>
      </div>
    </NodexDropdownMenu>
  );
}

function isAutomationCodexReasoningEffort(
  reasoningEffort: string,
): reasoningEffort is CodexScheduledAutomationReasoningEffort {
  return (
    reasoningEffort === "none" ||
    reasoningEffort === "minimal" ||
    reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high" ||
    reasoningEffort === "xhigh" ||
    reasoningEffort === "max"
  );
}

function resolveAutomationSelectorReasoningEffort(
  reasoningEffort: WorkbenchAutomationDraft["reasoningEffort"],
): CodexScheduledAutomationReasoningEffort {
  if (isAutomationCodexReasoningEffort(reasoningEffort)) return reasoningEffort;
  return "medium";
}

function resolveAutomationReasoningForModelChange(input: {
  currentReasoningEffort: CodexScheduledAutomationReasoningEffort;
  models: readonly CodexModelOption[];
  nextModelId: string;
}): CodexScheduledAutomationReasoningEffort {
  const selectedModel =
    input.models.find((candidate) => candidate.id === input.nextModelId && !candidate.hidden) ??
    null;
  const supportedOptions = resolveCodexReasoningEffortOptions(input.nextModelId, [
    ...input.models,
  ]).filter(
    (
      option,
    ): option is typeof option & {
      reasoningEffort: CodexScheduledAutomationReasoningEffort;
    } => isAutomationCodexReasoningEffort(option.reasoningEffort),
  );
  const supportedEfforts = new Set(supportedOptions.map((option) => option.reasoningEffort));

  if (supportedEfforts.has(input.currentReasoningEffort)) {
    return input.currentReasoningEffort;
  }

  const preferredEfforts: Array<CodexScheduledAutomationReasoningEffort | null | undefined> = [
    selectedModel && isAutomationCodexReasoningEffort(selectedModel.defaultReasoningEffort)
      ? selectedModel.defaultReasoningEffort
      : null,
    supportedEfforts.has("high") ? "high" : null,
    supportedOptions[0]?.reasoningEffort,
  ];

  for (const effort of preferredEfforts) {
    if (effort && supportedEfforts.has(effort)) {
      return effort;
    }
  }

  return "medium";
}

function AutomationModelReasoningDropdown({
  draft,
  models,
  modelsLoading,
  modelsError,
  disabled,
  onSelect,
}: {
  draft: WorkbenchAutomationDraft;
  models: readonly CodexModelOption[];
  modelsLoading: boolean;
  modelsError: boolean;
  disabled: boolean;
  onSelect: (model: string, reasoningEffort: CodexScheduledAutomationReasoningEffort) => void;
}) {
  const selectedModel = draft.model;
  const selectedReasoningEffort = draft.reasoningEffort;
  const visibleModels = useMemo(() => getVisibleCodexModels(models), [models]);
  const effectiveReasoningEffort =
    resolveAutomationSelectorReasoningEffort(selectedReasoningEffort);
  const reasoningOptions = useMemo(
    () =>
      resolveCodexReasoningEffortOptions(selectedModel, [...models]).filter(
        (
          option,
        ): option is typeof option & {
          reasoningEffort: CodexScheduledAutomationReasoningEffort;
        } => isAutomationCodexReasoningEffort(option.reasoningEffort),
      ),
    [models, selectedModel],
  );
  const hasModelChoices = visibleModels.length > 0;
  const selectedModelMissing = selectedModel.trim().length === 0;
  const triggerDisabled = disabled || modelsLoading || selectedModelMissing || !hasModelChoices;
  const modelLabel =
    modelsLoading || selectedModelMissing
      ? "Loading model"
      : hasModelChoices
        ? formatCodexModelLabel(selectedModel, [...models])
        : modelsError
          ? "Model unavailable"
          : "No models available";
  const reasoningLabel = formatCodexReasoningEffortLabel(effectiveReasoningEffort);

  return (
    <NodexDropdownMenu
      align="end"
      side="bottom"
      contentWidth="menu"
      disabled={triggerDisabled}
      triggerButton={
        <button
          type="button"
          aria-label="Model and reasoning"
          disabled={triggerDisabled}
          className={cn(
            AUTOMATION_FIELD_TRIGGER_CLASS,
            "inline-flex w-auto max-w-full justify-end",
            triggerDisabled && "cursor-default opacity-25 hover:bg-transparent",
            selectedModelMissing && !modelsLoading && "text-token-text-tertiary",
          )}
        >
          <span className="flex max-w-48 min-w-0 items-center gap-1.5 text-left">
            <span className="min-w-0 truncate text-token-foreground">{modelLabel}</span>
            {!modelsLoading && !selectedModelMissing && hasModelChoices ? (
              <span className="shrink-0 text-token-description-foreground">{reasoningLabel}</span>
            ) : null}
          </span>
          {modelsLoading ? (
            <AutomationLoadingIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
          ) : (
            <CompactChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
          )}
        </button>
      }
    >
      <NodexDropdownTitle>Reasoning</NodexDropdownTitle>
      {reasoningOptions.map((option) => (
        <NodexDropdownItem
          key={option.reasoningEffort}
          rightSlot={
            option.reasoningEffort === effectiveReasoningEffort ? (
              <NodexDropdownSelectedIcon />
            ) : null
          }
          tooltipText={option.description}
          onSelect={() => onSelect(selectedModel, option.reasoningEffort)}
        >
          {formatCodexReasoningEffortLabel(option.reasoningEffort)}
        </NodexDropdownItem>
      ))}
      <NodexDropdownSeparator />
      <NodexDropdownTitle>Model</NodexDropdownTitle>
      <div className="vertical-scroll-fade-mask flex max-h-[250px] flex-col overflow-y-auto">
        {visibleModels.length === 0 ? (
          <NodexDropdownMessage compact>No models available</NodexDropdownMessage>
        ) : (
          visibleModels.map((model) => {
            const selected = model.id === selectedModel;
            const description = model.description.trim().replace(/\.$/u, "");
            return (
              <NodexDropdownItem
                key={model.id}
                rightSlot={selected ? <NodexDropdownSelectedIcon /> : null}
                tooltipText={description || undefined}
                onSelect={() => {
                  const reasoningEffort = resolveAutomationReasoningForModelChange({
                    currentReasoningEffort: effectiveReasoningEffort,
                    models,
                    nextModelId: model.id,
                  });
                  onSelect(model.id, reasoningEffort);
                }}
              >
                {formatCodexModelLabel(model.id, [...models])}
              </NodexDropdownItem>
            );
          })
        )}
      </div>
    </NodexDropdownMenu>
  );
}

function AutomationDetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-1 text-base text-token-input-placeholder-foreground">
        <div className="opacity-75">{title}</div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">{children}</div>
    </section>
  );
}

function AutomationDetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid h-[1.875rem] w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 overflow-x-hidden rounded-lg text-base leading-[18px] text-token-foreground">
      <div className="min-w-0 pl-1 pr-2 text-left">{label}</div>
      <div className="flex min-w-0 justify-end justify-self-stretch overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function AutomationRowAction({
  label,
  disabled = false,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex cursor-interaction items-center justify-center text-token-description-foreground outline-none disabled:cursor-default disabled:opacity-50",
          "focus-visible:ring-token-focus focus-visible:ring-2",
          danger ? "hover:text-token-error-foreground" : "hover:text-token-foreground",
        )}
      >
        {children}
      </button>
    </NodexTooltip>
  );
}

function AutomationArchiveRunsDialog({
  rows,
  onOpenChange,
  onConfirm,
}: {
  rows: WorkbenchAutomationPreviousRunRowModel[];
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const count = rows.length;
  return (
    <NodexDialog open={count > 0} onOpenChange={onOpenChange}>
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>
              {count === 1 ? "Archive 1 run?" : `Archive ${count} runs?`}
            </NodexDialogTitle>
            <NodexDialogDescription>
              {count === 1
                ? "This will archive the chat. You can find it later in your archived chats."
                : "This will archive their chats. You can find them later in your archived chats."}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction onClick={() => onOpenChange(false)}>Cancel</NodexDialogAction>
            <NodexDialogAction tone="danger" onClick={() => void onConfirm()}>
              {count === 1 ? "Archive" : "Archive all"}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function AutomationPreviousRunStatusIcon({ row }: { row: WorkbenchAutomationPreviousRunRowModel }) {
  if (row.isInProgress) {
    return <AutomationLoadingIcon className="icon-xs" />;
  }

  if (row.isUnread) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full",
          row.isArchived ? "bg-token-error-foreground" : "bg-token-charts-blue",
        )}
      />
    );
  }

  if (row.isArchived) {
    return <AutomationArchiveIcon className="icon-xs text-token-text-tertiary" />;
  }

  return (
    <span aria-hidden="true" className="size-2 rounded-full bg-token-description-foreground" />
  );
}

const AUTOMATION_PREVIOUS_RUN_MENU_TARGET_ATTRIBUTE = "data-automation-previous-run-menu-target";

function AutomationPreviousRunsContextMenu({
  rows,
  disabled,
  onArchive,
  onUnarchive,
  onMarkReadState,
  children,
}: {
  rows: WorkbenchAutomationPreviousRunRowModel[];
  disabled: boolean;
  onArchive: (row: WorkbenchAutomationPreviousRunRowModel) => void;
  onUnarchive: (row: WorkbenchAutomationPreviousRunRowModel) => void;
  onMarkReadState: (row: WorkbenchAutomationPreviousRunRowModel, readAt: number | null) => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [targetThreadId, setTargetThreadId] = useState<string | null>(null);
  const targetRow =
    targetThreadId === null ? null : (rows.find((row) => row.threadId === targetThreadId) ?? null);

  const handleMenuOpenChange = (open: boolean): void => {
    setMenuOpen(open);
    if (!open) setTargetThreadId(null);
  };

  const handleContextMenu = (event: MouseEvent<HTMLSpanElement>): void => {
    if (!(event.target instanceof Element)) {
      event.stopPropagation();
      return;
    }
    const target = event.target.closest<HTMLElement>(
      `[${AUTOMATION_PREVIOUS_RUN_MENU_TARGET_ATTRIBUTE}]`,
    );
    const nextTargetThreadId = target?.getAttribute(AUTOMATION_PREVIOUS_RUN_MENU_TARGET_ATTRIBUTE);
    if (!nextTargetThreadId || !rows.some((row) => row.threadId === nextTargetThreadId)) {
      event.stopPropagation();
      return;
    }
    setTargetThreadId(nextTargetThreadId);
  };

  if (disabled) return <>{children}</>;

  return (
    <NodexContextMenuRoot open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <NodexContextMenuTrigger>
        <span className="contents" data-automation-previous-run-menu-region="true">
          <span className="contents" onContextMenu={handleContextMenu}>
            {children}
          </span>
        </span>
      </NodexContextMenuTrigger>
      {targetRow ? (
        <NodexContextMenuPortal>
          <NodexContextMenuContent className="min-w-40">
            {targetRow.canUnarchive ? (
              <NodexContextMenuItem
                className="cursor-interaction rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm outline-hidden hover:bg-token-list-hover-background focus:bg-token-list-hover-background"
                onSelect={() => onUnarchive(targetRow)}
              >
                Unarchive
              </NodexContextMenuItem>
            ) : null}
            <NodexContextMenuItem
              className="cursor-interaction rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm outline-hidden hover:bg-token-list-hover-background focus:bg-token-list-hover-background"
              onSelect={() => onMarkReadState(targetRow, targetRow.isUnread ? Date.now() : null)}
            >
              {targetRow.isUnread ? "Mark as read" : "Mark as unread"}
            </NodexContextMenuItem>
            {targetRow.canArchive ? (
              <NodexContextMenuItem
                className="cursor-interaction rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm outline-hidden hover:bg-token-list-hover-background focus:bg-token-list-hover-background"
                onSelect={() => onArchive(targetRow)}
              >
                Archive
              </NodexContextMenuItem>
            ) : null}
          </NodexContextMenuContent>
        </NodexContextMenuPortal>
      ) : null}
    </NodexContextMenuRoot>
  );
}

function AutomationPreviousRunRow({
  row,
  disabled,
  onOpenRun,
  onUnarchive,
}: {
  row: WorkbenchAutomationPreviousRunRowModel;
  disabled: boolean;
  onOpenRun?: (row: WorkbenchAutomationPreviousRunRowModel) => void;
  onUnarchive: (row: WorkbenchAutomationPreviousRunRowModel) => void;
}) {
  const canOpen = row.canOpen && onOpenRun !== undefined && !disabled;
  const selectRun = () => {
    if (!canOpen) return;
    onOpenRun(row);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectRun();
  };

  return (
    <div
      role="listitem"
      data-testid={`automation-previous-run-${row.threadId}`}
      data-automation-previous-run-menu-target={row.threadId}
      className="group relative min-w-0"
    >
      <div
        role="button"
        tabIndex={canOpen ? 0 : -1}
        aria-disabled={!canOpen}
        aria-label={row.title}
        onClick={selectRun}
        onKeyDown={handleKeyDown}
        className={cn(
          "flex min-h-11 min-w-0 items-center gap-2 rounded-md py-2 pr-3 pl-1 text-base outline-none",
          canOpen
            ? "cursor-interaction hover:bg-token-list-hover-background focus-visible:ring-token-focus focus-visible:ring-2"
            : "cursor-default",
          row.isArchived && "opacity-65 hover:opacity-100 focus-within:opacity-100",
        )}
      >
        <span className="flex w-5 shrink-0 items-center justify-center text-token-description-foreground">
          <AutomationPreviousRunStatusIcon row={row} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-token-foreground">{row.title}</span>
            {row.sourceLabel ? (
              <span className="min-w-0 truncate text-sm text-token-description-foreground">
                {row.sourceLabel}
              </span>
            ) : null}
          </span>
          {row.item.description ? (
            <span className="min-w-0 truncate text-sm text-token-text-tertiary">
              {row.item.description}
            </span>
          ) : null}
        </span>
        <span className="flex min-w-[4.5rem] shrink-0 items-center justify-end">
          {row.canUnarchive ? (
            <button
              type="button"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onUnarchive(row);
              }}
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-md px-2 py-1 text-sm text-token-foreground opacity-0 outline-none hover:bg-token-list-hover-background focus:pointer-events-auto focus:opacity-100 focus-visible:ring-token-focus focus-visible:ring-2 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:cursor-default disabled:opacity-40"
            >
              Unarchive
            </button>
          ) : null}
          <span
            className={cn(
              "text-sm whitespace-nowrap text-token-description-foreground tabular-nums",
              row.canUnarchive && "group-focus-within:opacity-0 group-hover:opacity-0",
            )}
          >
            {row.relativeTimeLabel}
          </span>
        </span>
      </div>
    </div>
  );
}

function AutomationPreviousRunsSection({
  rows,
  loading,
  actionBusy,
  onOpenRun,
  onArchiveRuns,
  onUnarchiveRun,
  onMarkRunsRead,
  onMarkReadState,
}: {
  rows: WorkbenchAutomationPreviousRunRowModel[];
  loading: boolean;
  actionBusy: boolean;
  onOpenRun?: (row: WorkbenchAutomationPreviousRunRowModel) => void;
  onArchiveRuns: (
    rows: WorkbenchAutomationPreviousRunRowModel[],
    options?: { showSuccessToast?: boolean },
  ) => Promise<void>;
  onUnarchiveRun: (row: WorkbenchAutomationPreviousRunRowModel) => void;
  onMarkRunsRead: (rows: WorkbenchAutomationPreviousRunRowModel[], readAt: number) => Promise<void>;
  onMarkReadState: (row: WorkbenchAutomationPreviousRunRowModel, readAt: number | null) => void;
}) {
  const [archiveDialogState, setArchiveDialogState] = useState<{
    rows: WorkbenchAutomationPreviousRunRowModel[];
    showSuccessToast: boolean;
  } | null>(null);
  const unreadRows = rows.filter((row) => row.isUnread);
  const archiveableRows = rows.filter((row) => row.canArchive);
  const openArchiveDialog = (
    nextRows: WorkbenchAutomationPreviousRunRowModel[],
    options: { showSuccessToast?: boolean } = {},
  ) => {
    if (nextRows.length === 0) return;
    setArchiveDialogState({
      rows: nextRows,
      showSuccessToast: options.showSuccessToast === true,
    });
  };
  const closeArchiveDialog = () => setArchiveDialogState(null);
  const confirmArchiveDialog = async () => {
    const nextState = archiveDialogState;
    if (!nextState) return;
    closeArchiveDialog();
    await onArchiveRuns(nextState.rows, {
      showSuccessToast: nextState.showSuccessToast,
    });
  };
  const markAllRead = () => {
    const readAt = Date.now();
    void onMarkRunsRead(unreadRows, readAt);
  };

  const headerMenu = (
    <NodexDropdownMenu
      align="end"
      side="bottom"
      contentWidth="menuFixed"
      triggerButton={
        <button
          type="button"
          aria-label="Previous runs actions"
          className="flex size-7 cursor-interaction items-center justify-center rounded-md text-token-description-foreground outline-none hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:ring-token-focus focus-visible:ring-2"
        >
          <AutomationMoreIcon className="icon-xs" />
        </button>
      }
    >
      <NodexDropdownItem
        leftSlot={<NodexDropdownSelectedIcon className="icon-xs" />}
        disabled={actionBusy || unreadRows.length === 0}
        onSelect={markAllRead}
      >
        Mark all as read
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<AutomationArchiveIcon className="icon-xs" />}
        disabled={actionBusy || archiveableRows.length === 0}
        onSelect={() => openArchiveDialog(archiveableRows, { showSuccessToast: true })}
      >
        Archive all
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );

  return (
    <>
      <AutomationDetailSection title="Previous runs" action={headerMenu}>
        {loading && rows.length === 0 ? (
          <div className="flex min-h-11 items-center justify-start px-1 py-2 text-token-description-foreground">
            <AutomationLoadingIcon className="icon-sm" />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-1 py-2 text-base text-token-text-tertiary opacity-70">No chats</div>
        ) : (
          <AutomationPreviousRunsContextMenu
            rows={rows}
            disabled={actionBusy}
            onArchive={(target) => openArchiveDialog([target])}
            onUnarchive={onUnarchiveRun}
            onMarkReadState={onMarkReadState}
          >
            <div
              role="list"
              className="vertical-scroll-fade-mask flex max-h-64 min-h-0 flex-col overflow-y-auto [--edge-fade-distance:1rem]"
            >
              {rows.map((row) => (
                <AutomationPreviousRunRow
                  key={row.threadId}
                  row={row}
                  disabled={actionBusy}
                  onOpenRun={onOpenRun}
                  onUnarchive={onUnarchiveRun}
                />
              ))}
            </div>
          </AutomationPreviousRunsContextMenu>
        )}
      </AutomationDetailSection>
      <AutomationArchiveRunsDialog
        rows={archiveDialogState?.rows ?? []}
        onOpenChange={(open) => {
          if (!open) closeArchiveDialog();
        }}
        onConfirm={confirmArchiveDialog}
      />
    </>
  );
}

function AutomationStatusControl({
  row,
  disabled,
  onPauseAutomation,
  onResumeAutomation,
}: {
  row: WorkbenchAutomationRowModel;
  disabled: boolean;
  onPauseAutomation: (automation: CodexScheduledAutomation) => void;
  onResumeAutomation: (automation: CodexScheduledAutomation) => void;
}) {
  if (row.isInProgress) {
    return (
      <span className="relative inline-flex size-5 shrink-0 items-center justify-center text-token-description-foreground">
        <AutomationLoadingIcon className="icon-sm" />
        {row.hasUnreadRuns ? (
          <span className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-token-charts-blue ring-2 ring-token-main-surface-primary" />
        ) : null}
      </span>
    );
  }

  const label = row.isPaused ? "Resume" : "Pause";
  const toggle = row.isPaused ? onResumeAutomation : onPauseAutomation;
  return (
    <AutomationRowAction
      label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        toggle(row.automation);
      }}
    >
      <span className="group/status-toggle relative inline-flex size-5 items-center justify-center">
        {row.isPaused ? (
          <AutomationResumeIcon className="icon-sm" />
        ) : (
          <>
            <AutomationActiveStatusIcon className="icon-sm group-focus-within/status-toggle:opacity-0 group-hover/status-toggle:opacity-0" />
            <AutomationPauseIcon className="icon-sm absolute inset-0 opacity-0 group-focus-within/status-toggle:opacity-100 group-hover/status-toggle:opacity-100" />
          </>
        )}
        {row.hasUnreadRuns ? (
          <span className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-token-charts-blue ring-2 ring-token-main-surface-primary" />
        ) : null}
      </span>
    </AutomationRowAction>
  );
}

function AutomationListRow({
  row,
  active,
  isRunNowDisabled,
  isRunNowPending,
  isMutating,
  onSelect,
  onRunAutomationNow,
  onPauseAutomation,
  onResumeAutomation,
  onDeleteAutomation,
}: {
  row: WorkbenchAutomationRowModel;
  active: boolean;
  isRunNowDisabled: boolean;
  isRunNowPending: boolean;
  isMutating: boolean;
  onSelect: (automation: CodexScheduledAutomation) => void;
  onRunAutomationNow: (automation: CodexScheduledAutomation) => void;
  onPauseAutomation: (automation: CodexScheduledAutomation) => void;
  onResumeAutomation: (automation: CodexScheduledAutomation) => void;
  onDeleteAutomation: (automation: CodexScheduledAutomation) => void;
}) {
  const descriptionId = `automation-row-${row.automation.id}-description`;
  const selectRow = () => onSelect(row.automation);
  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectRow();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`automation-list-row-${row.automation.id}`}
      aria-current={active ? "page" : undefined}
      aria-label={row.displayName}
      aria-describedby={descriptionId}
      onClick={selectRow}
      onKeyDown={handleRowKeyDown}
      className={cn(
        "automation-row group relative flex min-h-10 w-full cursor-interaction items-center gap-2 rounded-lg px-3 py-3 text-left text-base outline-none",
        "hover:bg-token-list-active-selection-background focus-visible:ring-token-focus focus-visible:ring-2",
        active &&
          "bg-token-list-active-selection-background text-token-list-active-selection-foreground",
        row.isPaused && !active && "opacity-60 hover:opacity-100 focus-within:opacity-100",
      )}
    >
      <AutomationStatusControl
        row={row}
        disabled={isMutating}
        onPauseAutomation={onPauseAutomation}
        onResumeAutomation={onResumeAutomation}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1 pr-24">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-base text-token-foreground">
            {row.displayName}
          </span>
        </span>
        <span
          id={descriptionId}
          className="flex min-w-0 items-center gap-1.5 text-sm text-token-text-secondary"
        >
          <span className="min-w-0 truncate">{row.workspaceLabel ?? "-"}</span>
          {row.secondaryStatusLabel ? (
            <span className="shrink-0 text-token-description-foreground">
              {row.secondaryStatusLabel}
            </span>
          ) : null}
          {row.secondaryStatusLabel ? (
            <span className="shrink-0 text-token-text-tertiary">·</span>
          ) : null}
          <span className="min-w-0 truncate">{row.scheduleLabel}</span>
        </span>
      </span>
      <span className="relative inline-flex min-w-24 justify-end">
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-2.5 opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          <AutomationRowAction
            label="Run now"
            disabled={isRunNowDisabled || isMutating}
            onClick={(event) => {
              event.stopPropagation();
              onRunAutomationNow(row.automation);
            }}
          >
            {isRunNowPending ? (
              <AutomationLoadingIcon className="icon-sm" />
            ) : (
              <AutomationRunNowIcon className="icon-sm" />
            )}
          </AutomationRowAction>
          <AutomationRowAction
            label="Edit scheduled task"
            disabled={isMutating}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(row.automation);
            }}
          >
            <EditIcon className="icon-sm" />
          </AutomationRowAction>
          <AutomationRowAction
            label="Delete"
            disabled={isMutating}
            danger
            onClick={(event) => {
              event.stopPropagation();
              onDeleteAutomation(row.automation);
            }}
          >
            <DeleteIcon className="icon-sm" />
          </AutomationRowAction>
        </span>
      </span>
    </div>
  );
}

function AutomationPageTabs({
  selectedTab,
  onSelectTab,
}: {
  selectedTab: WorkbenchAutomationsTab;
  onSelectTab: (tab: WorkbenchAutomationsTab) => void;
}) {
  const tabs: Array<{ id: WorkbenchAutomationsTab; label: string }> = [
    { id: "tasks", label: "Tasks" },
    { id: "templates", label: "Templates" },
  ];

  return (
    <div
      aria-label="Scheduled tasks or templates"
      role="group"
      className="inline-flex items-center gap-1.5"
    >
      {tabs.map((tab) => {
        const active = selectedTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelectTab(tab.id)}
            className={cn(
              AUTOMATION_TOOLBAR_BUTTON_BASE_CLASS,
              active
                ? AUTOMATION_TOOLBAR_BUTTON_SECONDARY_CLASS
                : AUTOMATION_TOOLBAR_BUTTON_GHOST_CLASS,
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function CreateAutomationSplitControl({
  onCreateManually,
  onCreateWithChat,
}: {
  onCreateManually: () => void;
  onCreateWithChat?: () => void;
}) {
  const chatDisabled = onCreateWithChat === undefined;
  const primaryAction = onCreateWithChat ?? onCreateManually;
  return (
    <div className="inline-flex items-center">
      <button
        type="button"
        aria-label={chatDisabled ? "Create manually" : "Create via chat"}
        onClick={primaryAction}
        className={cn(
          AUTOMATION_TOOLBAR_BUTTON_BASE_CLASS,
          AUTOMATION_TOOLBAR_BUTTON_OUTLINE_CLASS,
          "rounded-r-none border-r-0 pr-1",
        )}
      >
        {chatDisabled ? "Create manually" : "Create via chat"}
      </button>
      <NodexDropdownMenu
        align="end"
        side="bottom"
        contentWidth="menuFixed"
        triggerButton={
          <button
            type="button"
            aria-label="New scheduled task options"
            className={cn(
              AUTOMATION_TOOLBAR_BUTTON_BASE_CLASS,
              AUTOMATION_TOOLBAR_BUTTON_OUTLINE_CLASS,
              "aspect-square justify-center rounded-l-none !px-0",
            )}
          >
            <CompactChevronDownIcon className="icon-xs text-token-text-tertiary" />
          </button>
        }
      >
        <NodexDropdownItem
          leftSlot={<SidePanelSideChatIcon className="icon-xs" />}
          disabled={chatDisabled}
          onSelect={onCreateWithChat}
        >
          Create via chat
        </NodexDropdownItem>
        <NodexDropdownItem
          leftSlot={<SidePanelPlusIcon className="icon-xs" />}
          onSelect={onCreateManually}
        >
          Create manually
        </NodexDropdownItem>
      </NodexDropdownMenu>
    </div>
  );
}

function AutomationsRouteHeader({
  selectedTab,
  detailMode,
  placement = "inline",
  onSelectTab,
  onCreateManually,
  onCreateWithChat,
}: {
  selectedTab: WorkbenchAutomationsTab;
  detailMode: "create" | "edit" | "loading" | "missing" | null;
  placement?: "inline" | "shell";
  onSelectTab: (tab: WorkbenchAutomationsTab) => void;
  onCreateManually: () => void;
  onCreateWithChat?: () => void;
}) {
  const className =
    placement === "shell"
      ? "draggable grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 electron:h-toolbar extension:py-row-y"
      : "draggable grid h-toolbar w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-token-border px-panel";

  return (
    <header className={className}>
      <div className="min-w-0 text-base">
        <AutomationPageTabs selectedTab={selectedTab} onSelectTab={onSelectTab} />
      </div>
      <div className="no-drag flex items-center justify-end">
        {detailMode === "create" ? null : (
          <CreateAutomationSplitControl
            onCreateManually={onCreateManually}
            onCreateWithChat={onCreateWithChat}
          />
        )}
      </div>
    </header>
  );
}

function AutomationDetailToolbarButton({
  label,
  active,
  disabled = false,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          AUTOMATION_TOOLBAR_BUTTON_BASE_CLASS,
          AUTOMATION_TOOLBAR_BUTTON_GHOST_CLASS,
          "aspect-square justify-center !px-0 text-token-text-tertiary hover:text-token-foreground",
          danger && "hover:text-token-error-foreground",
        )}
      >
        {children}
      </button>
    </NodexTooltip>
  );
}

function AutomationDetailRunNowButton({
  disabled,
  pending,
  onClick,
}: {
  disabled: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(AUTOMATION_TOOLBAR_BUTTON_BASE_CLASS, AUTOMATION_TOOLBAR_BUTTON_PRIMARY_CLASS)}
    >
      {pending ? (
        <AutomationLoadingIcon className="icon-xs" />
      ) : (
        <AutomationRunNowIcon className="icon-xs" />
      )}
      Run now
    </button>
  );
}

function AutomationsEmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center px-6 py-8 text-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary">
          {icon}
        </div>
        <div className="text-lg text-token-foreground">{title}</div>
        {description ? (
          <div className="text-sm leading-5 text-token-text-secondary">{description}</div>
        ) : null}
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}

function AutomationsSearchablePageLayout({
  title,
  subtitle,
  searchLabel,
  searchValue,
  onSearchValueChange,
  contentClassName,
  children,
}: {
  title: string;
  subtitle: string;
  searchLabel: string;
  searchValue: string;
  onSearchValueChange: (value: string) => void;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative h-full min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="flex min-h-full w-full flex-col">
        <div className="mx-auto w-full max-w-[var(--thread-content-max-width)] px-panel pt-panel pb-4">
          <div className="flex flex-col gap-2 px-2">
            <h1 className="heading-xl font-normal text-token-foreground">{title}</h1>
            <p className="text-lg leading-6 text-token-text-secondary">{subtitle}</p>
          </div>
        </div>
        <div className="sticky top-0 z-30 bg-token-main-surface-primary after:pointer-events-none after:absolute after:top-full after:right-0 after:left-0 after:h-8 after:bg-linear-to-b after:from-token-main-surface-primary after:to-transparent after:content-['']">
          <div className="mx-auto w-full max-w-[var(--thread-content-max-width)] px-panel pb-2">
            <label className="relative block w-full min-w-0">
              <span className="sr-only">{searchLabel}</span>
              <SettingsSearchIcon className="icon-xs pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-token-text-tertiary" />
              <Input
                aria-label={searchLabel}
                value={searchValue}
                placeholder={searchLabel}
                onInput={(event) => onSearchValueChange(event.currentTarget.value)}
                className="w-full pl-8"
              />
            </label>
          </div>
        </div>
        <div
          className={cn(
            "mx-auto flex min-h-0 w-full max-w-[var(--thread-content-max-width)] flex-1 flex-col px-panel pt-5 pb-panel",
            contentClassName,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function AutomationSection({
  title,
  rows,
  selectedAutomationId,
  onSelectAutomation,
  onRunAutomationNow,
  onPauseAutomation,
  onResumeAutomation,
  onDeleteAutomation,
  runNowPendingAutomationId,
  mutatingAutomationId,
}: {
  title: string;
  rows: WorkbenchAutomationRowModel[];
  selectedAutomationId: string | null;
  onSelectAutomation: (automation: CodexScheduledAutomation) => void;
  onRunAutomationNow: (automation: CodexScheduledAutomation) => void;
  onPauseAutomation: (automation: CodexScheduledAutomation) => void;
  onResumeAutomation: (automation: CodexScheduledAutomation) => void;
  onDeleteAutomation: (automation: CodexScheduledAutomation) => void;
  runNowPendingAutomationId: string | null;
  mutatingAutomationId: string | null;
}) {
  if (rows.length === 0) return null;
  const isRunNowDisabled = runNowPendingAutomationId !== null;

  return (
    <section className="flex flex-col gap-1.5">
      <div className="px-2 text-xs font-medium uppercase text-token-text-tertiary">{title}</div>
      <div className="-mx-3 flex flex-col" role="list">
        {rows.map((row) => (
          <div
            key={row.automation.id}
            className="relative before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-token-border-light before:content-[''] first:before:hidden"
            role="listitem"
          >
            <AutomationListRow
              row={row}
              active={row.automation.id === selectedAutomationId}
              isRunNowDisabled={isRunNowDisabled}
              isRunNowPending={runNowPendingAutomationId === row.automation.id}
              isMutating={mutatingAutomationId === row.automation.id}
              onSelect={onSelectAutomation}
              onRunAutomationNow={onRunAutomationNow}
              onPauseAutomation={onPauseAutomation}
              onResumeAutomation={onResumeAutomation}
              onDeleteAutomation={onDeleteAutomation}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

const SCHEDULED_AUTOMATIONS_LEARN_MORE_URL = "https://developers.openai.com/codex/app/automations";

function AutomationFirstRunSuggestionIcon({
  suggestion,
}: {
  suggestion: WorkbenchAutomationFirstRunSuggestion;
}) {
  const templateIconName =
    suggestion.iconName === "file-text"
      ? "text-document"
      : suggestion.iconName === "radar"
        ? "radar"
        : "star-app";

  return <AutomationTemplateColorIcon iconName={templateIconName} className="icon-sm" />;
}

function AutomationsFirstRunEmptyState({
  onCreateManually,
  onCreateWithChat,
}: {
  onCreateManually: () => void;
  onCreateWithChat?: (prompt: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mx-auto flex w-full max-w-[var(--thread-content-max-width)] flex-col gap-1 px-panel pt-panel pb-6">
        <h1 className="heading-xl font-normal text-token-foreground">Scheduled</h1>
        <p className="text-lg font-normal text-token-description-foreground">
          Ask ChatGPT to schedule tasks, set reminders, or monitor for updates.{" "}
          <a
            className="text-token-link hover:underline"
            href={SCHEDULED_AUTOMATIONS_LEARN_MORE_URL}
            rel="noreferrer"
            target="_blank"
          >
            Learn more
          </a>
        </p>
      </div>
      <AutomationsEmptyState
        icon={<AutomationsIcon className="icon-sm" />}
        title="Create your first scheduled task"
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onCreateWithChat ? (
              WORKBENCH_AUTOMATION_FIRST_RUN_SUGGESTIONS.map((suggestion) => (
                <NodexButton
                  key={suggestion.id}
                  variant="outline"
                  size="default"
                  onClick={() => onCreateWithChat(suggestion.prompt)}
                >
                  <AutomationFirstRunSuggestionIcon suggestion={suggestion} />
                  {suggestion.name}
                </NodexButton>
              ))
            ) : (
              <NodexButton variant="outline" size="default" onClick={onCreateManually}>
                <SidePanelPlusIcon className="icon-sm" />
                Create manually
              </NodexButton>
            )}
          </div>
        }
      />
    </div>
  );
}

function AutomationsFirstRunLoadingState() {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-token-description-foreground">
      <AutomationLoadingIcon className="icon-sm" />
      Loading…
    </div>
  );
}

function AutomationsTasksPanel({
  automations,
  runningAutomationIds,
  unreadAutomationIds,
  selectedAutomationId,
  loading,
  runNowPendingAutomationId,
  mutatingAutomationId,
  onSelectAutomation,
  onRunAutomationNow,
  onPauseAutomation,
  onResumeAutomation,
  onDeleteAutomation,
  onCreateManually,
  onCreateWithChat,
}: {
  automations: CodexScheduledAutomation[];
  runningAutomationIds: ReadonlySet<string>;
  unreadAutomationIds: ReadonlySet<string>;
  selectedAutomationId: string | null;
  loading: boolean;
  runNowPendingAutomationId: string | null;
  mutatingAutomationId: string | null;
  onSelectAutomation: (automation: CodexScheduledAutomation) => void;
  onRunAutomationNow: (automation: CodexScheduledAutomation) => void;
  onPauseAutomation: (automation: CodexScheduledAutomation) => void;
  onResumeAutomation: (automation: CodexScheduledAutomation) => void;
  onDeleteAutomation: (automation: CodexScheduledAutomation) => void;
  onCreateManually: () => void;
  onCreateWithChat?: (prompt: string) => void;
}) {
  const [searchValue, setSearchValue] = useState("");
  const listModel = useMemo(
    () =>
      buildWorkbenchAutomationListModel({
        automations,
        runningAutomationIds,
        unreadAutomationIds,
        searchQuery: searchValue,
      }),
    [automations, runningAutomationIds, searchValue, unreadAutomationIds],
  );
  const visibleRowCount = listModel.current.length + listModel.paused.length;

  if (loading && automations.length === 0) {
    return <AutomationsFirstRunLoadingState />;
  }

  if (!loading && automations.length === 0) {
    return (
      <AutomationsFirstRunEmptyState
        onCreateManually={onCreateManually}
        onCreateWithChat={onCreateWithChat}
      />
    );
  }

  return (
    <AutomationsSearchablePageLayout
      title="Scheduled"
      subtitle="Manage recurring tasks, reminders, and monitors"
      searchLabel="Search scheduled tasks"
      searchValue={searchValue}
      onSearchValueChange={setSearchValue}
      contentClassName="gap-8 !pt-6 [&>section]:gap-2"
    >
      {loading ? (
        <AutomationsEmptyState
          icon={<AutomationsIcon className="icon-sm" />}
          title="Loading scheduled tasks"
          description="Reading local automation metadata."
        />
      ) : visibleRowCount === 0 ? (
        <AutomationsEmptyState
          icon={<SettingsSearchIcon className="icon-sm" />}
          title="No scheduled tasks found"
          description="Try another search"
        />
      ) : (
        <>
          <AutomationSection
            title="Current"
            rows={listModel.current}
            selectedAutomationId={selectedAutomationId}
            onSelectAutomation={onSelectAutomation}
            onRunAutomationNow={onRunAutomationNow}
            onPauseAutomation={onPauseAutomation}
            onResumeAutomation={onResumeAutomation}
            onDeleteAutomation={onDeleteAutomation}
            runNowPendingAutomationId={runNowPendingAutomationId}
            mutatingAutomationId={mutatingAutomationId}
          />
          <AutomationSection
            title="Paused"
            rows={listModel.paused}
            selectedAutomationId={selectedAutomationId}
            onSelectAutomation={onSelectAutomation}
            onRunAutomationNow={onRunAutomationNow}
            onPauseAutomation={onPauseAutomation}
            onResumeAutomation={onResumeAutomation}
            onDeleteAutomation={onDeleteAutomation}
            runNowPendingAutomationId={runNowPendingAutomationId}
            mutatingAutomationId={mutatingAutomationId}
          />
        </>
      )}
    </AutomationsSearchablePageLayout>
  );
}

function AutomationTemplateIcon({ iconName }: { iconName: string }) {
  return <AutomationTemplateColorIcon iconName={iconName} className="icon-sm" />;
}

function AutomationTemplateCard({
  template,
  onSelectTemplate,
}: {
  template: WorkbenchAutomationTemplate;
  onSelectTemplate: (template: WorkbenchAutomationTemplate) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`automation-template-${template.id}`}
      onClick={() => onSelectTemplate(template)}
      className="group flex min-h-28 w-full cursor-interaction flex-col items-start gap-2 rounded-lg border border-token-border/50 bg-token-input-background/70 px-3 py-3 text-left text-base outline-none hover:border-token-border hover:bg-token-list-hover-background focus-visible:ring-token-focus focus-visible:ring-2"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary group-hover:text-token-foreground">
        <AutomationTemplateIcon iconName={template.iconName} />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-base font-medium text-token-foreground">{template.name}</span>
        <span className="line-clamp-2 text-sm leading-5 text-token-text-secondary">
          {template.prompt}
        </span>
        <span className="text-sm text-token-description-foreground">{template.scheduleLabel}</span>
      </span>
    </button>
  );
}

function AutomationsTemplatesPanel({
  onSelectTemplate,
}: {
  onSelectTemplate: (template: WorkbenchAutomationTemplate) => void;
}) {
  const [searchValue, setSearchValue] = useState("");
  const templates = useMemo(
    () => filterWorkbenchAutomationTemplates(WORKBENCH_AUTOMATION_TEMPLATES, searchValue),
    [searchValue],
  );

  return (
    <AutomationsSearchablePageLayout
      title="Templates"
      subtitle="Start with a scheduled task template"
      searchLabel="Search templates"
      searchValue={searchValue}
      onSearchValueChange={setSearchValue}
      contentClassName="gap-10 !pt-6"
    >
      {templates.length === 0 ? (
        <AutomationsEmptyState
          icon={<SettingsSearchIcon className="icon-sm" />}
          title="No templates found"
          description="Try another search"
        />
      ) : (
        <div className="flex w-full flex-col gap-3">
          <div className="px-1 text-xs font-medium uppercase text-token-text-tertiary">System</div>
          <div className="grid gap-4 md:grid-cols-2">
            {templates.map((template) => (
              <AutomationTemplateCard
                key={template.id}
                template={template}
                onSelectTemplate={onSelectTemplate}
              />
            ))}
          </div>
        </div>
      )}
    </AutomationsSearchablePageLayout>
  );
}

function AutomationDetailSurface({
  automation,
  projects,
  selectedAutomationId,
  mode,
  draft,
  setDraft,
  validation,
  createDraftTemplate,
  codexModels,
  codexModelsLoading,
  codexModelsError,
  previousRunRows,
  previousRunsLoading,
  loading,
  onBackToList,
  onSave,
  onPersonalizeTemplate,
  onOpenRun,
  onArchiveRuns,
  onUnarchiveRun,
  onMarkRunsRead,
  onMarkRunReadState,
  onOpenLocalEnvironmentsSettings,
  isMutating,
  isTemplatePersonalizationPending,
  isRunActionBusy,
  errorMessage,
}: {
  automation: CodexScheduledAutomation | null;
  projects: readonly Project[];
  selectedAutomationId: string | null;
  mode: "create" | "edit" | "loading" | "missing" | null;
  draft: WorkbenchAutomationDraft;
  setDraft: Dispatch<SetStateAction<WorkbenchAutomationDraft>>;
  validation: WorkbenchAutomationDraftValidation;
  createDraftTemplate: WorkbenchAutomationTemplate | null;
  codexModels: readonly CodexModelOption[];
  codexModelsLoading: boolean;
  codexModelsError: boolean;
  previousRunRows: WorkbenchAutomationPreviousRunRowModel[];
  previousRunsLoading: boolean;
  loading: boolean;
  onBackToList: () => void;
  onSave: (draft: WorkbenchAutomationDraft) => Promise<void>;
  onPersonalizeTemplate?: (template: WorkbenchAutomationTemplate) => Promise<void>;
  onOpenRun?: (row: WorkbenchAutomationPreviousRunRowModel) => void;
  onArchiveRuns: (
    rows: WorkbenchAutomationPreviousRunRowModel[],
    options?: { showSuccessToast?: boolean },
  ) => Promise<void>;
  onUnarchiveRun: (row: WorkbenchAutomationPreviousRunRowModel) => void;
  onMarkRunsRead: (rows: WorkbenchAutomationPreviousRunRowModel[], readAt: number) => Promise<void>;
  onMarkRunReadState: (row: WorkbenchAutomationPreviousRunRowModel, readAt: number | null) => void;
  onOpenLocalEnvironmentsSettings?: (input: {
    projectId: string | null;
    configPath: string | null;
  }) => void;
  isMutating: boolean;
  isTemplatePersonalizationPending: boolean;
  isRunActionBusy: boolean;
  errorMessage: string | null;
}) {
  if (mode === "loading" || loading) {
    return (
      <AutomationsEmptyState
        icon={<AutomationsIcon className="icon-sm" />}
        title="Loading scheduled task"
        description="Reading the latest automation metadata for this workspace."
      />
    );
  }

  if (mode === "missing") {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center px-6 py-8 text-center">
        <div className="flex max-w-md flex-col items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary">
            <AutomationTemplateColorIcon iconName="exclamationmark-bubble" className="icon-sm" />
          </div>
          <div className="text-lg text-token-foreground">Scheduled task not found</div>
          <div className="text-sm leading-5 text-token-text-secondary">
            This scheduled task may have been deleted or is no longer available on this machine.
          </div>
          <NodexButton variant="secondary" size="sm" onClick={onBackToList}>
            Back to Scheduled
          </NodexButton>
        </div>
      </div>
    );
  }

  if (mode !== "create" && !automation) {
    return (
      <AutomationsEmptyState
        icon={<AutomationsIcon className="icon-sm" />}
        title={selectedAutomationId ? "Scheduled task not found" : "Select a scheduled task"}
        description={
          selectedAutomationId
            ? "No local automation matches the selected id."
            : "Choose a scheduled task to inspect its target and next run."
        }
      />
    );
  }

  return (
    <AutomationDraftEditor
      automation={mode === "create" ? null : automation}
      projects={projects}
      mode={mode === "create" ? "create" : "edit"}
      draft={draft}
      setDraft={setDraft}
      validation={validation}
      createDraftTemplate={createDraftTemplate}
      codexModels={codexModels}
      codexModelsLoading={codexModelsLoading}
      codexModelsError={codexModelsError}
      previousRunRows={previousRunRows}
      previousRunsLoading={previousRunsLoading}
      onSave={onSave}
      onPersonalizeTemplate={onPersonalizeTemplate}
      onOpenRun={onOpenRun}
      onArchiveRuns={onArchiveRuns}
      onUnarchiveRun={onUnarchiveRun}
      onMarkRunsRead={onMarkRunsRead}
      onMarkRunReadState={onMarkRunReadState}
      onOpenLocalEnvironmentsSettings={onOpenLocalEnvironmentsSettings}
      isMutating={isMutating}
      isTemplatePersonalizationPending={isTemplatePersonalizationPending}
      isRunActionBusy={isRunActionBusy}
      errorMessage={errorMessage}
    />
  );
}

function AutomationDraftEditor({
  automation,
  projects,
  mode,
  draft,
  setDraft,
  validation,
  createDraftTemplate,
  codexModels,
  codexModelsLoading,
  codexModelsError,
  formId = "automation-detail-form",
  manualSubmit = false,
  showHeaderCreateAction = true,
  previousRunRows,
  previousRunsLoading,
  onSave,
  onPersonalizeTemplate,
  onOpenRun,
  onArchiveRuns,
  onUnarchiveRun,
  onMarkRunsRead,
  onMarkRunReadState,
  onOpenLocalEnvironmentsSettings,
  isMutating,
  isTemplatePersonalizationPending,
  isRunActionBusy,
  errorMessage,
}: {
  automation: CodexScheduledAutomation | null;
  projects: readonly Project[];
  mode: "create" | "edit";
  draft: WorkbenchAutomationDraft;
  setDraft: Dispatch<SetStateAction<WorkbenchAutomationDraft>>;
  validation: WorkbenchAutomationDraftValidation;
  createDraftTemplate: WorkbenchAutomationTemplate | null;
  codexModels: readonly CodexModelOption[];
  codexModelsLoading: boolean;
  codexModelsError: boolean;
  formId?: string;
  manualSubmit?: boolean;
  showHeaderCreateAction?: boolean;
  previousRunRows: WorkbenchAutomationPreviousRunRowModel[];
  previousRunsLoading: boolean;
  onSave: (draft: WorkbenchAutomationDraft) => Promise<void>;
  onPersonalizeTemplate?: (template: WorkbenchAutomationTemplate) => Promise<void>;
  onOpenRun?: (row: WorkbenchAutomationPreviousRunRowModel) => void;
  onArchiveRuns: (
    rows: WorkbenchAutomationPreviousRunRowModel[],
    options?: { showSuccessToast?: boolean },
  ) => Promise<void>;
  onUnarchiveRun: (row: WorkbenchAutomationPreviousRunRowModel) => void;
  onMarkRunsRead: (rows: WorkbenchAutomationPreviousRunRowModel[], readAt: number) => Promise<void>;
  onMarkRunReadState: (row: WorkbenchAutomationPreviousRunRowModel, readAt: number | null) => void;
  onOpenLocalEnvironmentsSettings?: (input: {
    projectId: string | null;
    configPath: string | null;
  }) => void;
  isMutating: boolean;
  isTemplatePersonalizationPending: boolean;
  isRunActionBusy: boolean;
  errorMessage: string | null;
}) {
  const canCreate = mode === "create" && validation.canSave && !isMutating;
  const canSubmit = (mode === "create" || manualSubmit) && validation.canSave && !isMutating;
  const createTooltip =
    mode === "create"
      ? formatWorkbenchAutomationDraftSaveTooltip({
          draft,
          action: "create",
        })
      : null;
  const canPersonalizeTemplate =
    mode === "create" &&
    createDraftTemplate !== null &&
    onPersonalizeTemplate !== undefined &&
    !isMutating &&
    !isTemplatePersonalizationPending;
  const scheduleIntervalStyle: WorkbenchAutomationScheduleIntervalStyle =
    draft.kind === "heartbeat" ? "heartbeat" : "default";
  const scheduleConfig = useMemo(
    () =>
      resolveWorkbenchAutomationScheduleConfig({
        rrule: draft.rrule,
        intervalStyle: scheduleIntervalStyle,
      }),
    [draft.rrule, scheduleIntervalStyle],
  );
  const runInTarget = resolveDraftRunInTarget(draft);
  const runInOptions: Array<"local" | "worktree" | "thread"> =
    automation === null
      ? ["local", "worktree", "thread"]
      : automation.kind === "heartbeat"
        ? ["thread"]
        : ["local", "worktree"];
  const nextRunLabel = automation
    ? formatCodexScheduledAutomationNextRunLabel(automation.nextRunAt)
    : formatWorkbenchAutomationScheduleLabel(scheduleConfig);

  const updateDraft = (patch: Partial<WorkbenchAutomationDraft>) => {
    setDraft((current) => ({
      ...current,
      ...patch,
    }));
  };

  const updateRunInTarget = (target: "local" | "worktree" | "thread") => {
    setDraft((current) => {
      if (automation && (automation.kind === "heartbeat") !== (target === "thread")) {
        return current;
      }

      if (target === "thread") {
        return {
          ...current,
          kind: "heartbeat",
          targetThreadId: current.targetThreadId,
          cwds: [],
          model: "",
          reasoningEffort: "",
          executionEnvironment: "worktree",
          localEnvironmentConfigPath: "",
        };
      }

      const nextDraft: WorkbenchAutomationDraft = {
        ...current,
        kind: "cron",
        targetThreadId: "",
        executionEnvironment: target,
        localEnvironmentConfigPath: target === "worktree" ? current.localEnvironmentConfigPath : "",
        model: current.model,
        reasoningEffort: current.reasoningEffort || DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT,
      };

      return codexModels.length > 0
        ? resolveWorkbenchAutomationDraftModelSettings({
            draft: nextDraft,
            models: codexModels,
          })
        : nextDraft;
    });
  };

  const saveDraft = async () => {
    if (!canSubmit) return;
    await onSave(draft);
  };

  const personalizeTemplate = async () => {
    if (!canPersonalizeTemplate || createDraftTemplate === null) return;
    await onPersonalizeTemplate(createDraftTemplate);
  };

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createDraftTemplate !== null && onPersonalizeTemplate !== undefined) return;
    if (mode === "create" || manualSubmit) {
      void saveDraft();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-panel">
      <form
        id={formId}
        className="mx-auto flex w-full max-w-3xl flex-col gap-8"
        onSubmit={submitForm}
      >
        <header className="flex min-w-0 flex-col gap-3">
          <Input
            id="automation-detail-panel-title"
            aria-label="Name"
            value={draft.name}
            autoFocus={mode === "create"}
            disabled={isMutating}
            placeholder={mode === "create" ? "Create scheduled task" : "Untitled scheduled task"}
            className="h-auto border-transparent bg-transparent px-0 py-0 text-heading-md text-token-foreground shadow-none placeholder:text-token-foreground focus:border-transparent"
            onInput={(event) => updateDraft({ name: event.currentTarget.value })}
          />
          <div className="truncate text-base text-token-text-secondary">{nextRunLabel}</div>
          <textarea
            aria-label="Prompt"
            value={draft.prompt}
            disabled={isMutating}
            placeholder="Describe what Nodex should do each time this scheduled task runs."
            className={AUTOMATION_TEXTAREA_CLASS}
            onInput={(event) => updateDraft({ prompt: event.currentTarget.value })}
          />
          {mode === "create" && showHeaderCreateAction ? (
            <div className="flex justify-end">
              {createDraftTemplate !== null && onPersonalizeTemplate !== undefined ? (
                <NodexButton
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={!canPersonalizeTemplate}
                  onClick={() => void personalizeTemplate()}
                >
                  {isTemplatePersonalizationPending ? (
                    <AutomationLoadingIcon className="icon-xs" />
                  ) : (
                    <SidePanelSideChatIcon className="icon-xs" />
                  )}
                  Personalize with Nodex
                </NodexButton>
              ) : (
                <NodexTooltip
                  tooltipContent={createTooltip}
                  disabled={createTooltip === null}
                  delayOpen
                >
                  <span className="inline-flex">
                    <NodexButton
                      type="submit"
                      variant="primary"
                      size="sm"
                      disabled={!canCreate}
                      className={canCreate ? undefined : "pointer-events-none"}
                    >
                      <SidePanelPlusIcon className="icon-xs" />
                      Create scheduled task
                    </NodexButton>
                  </span>
                </NodexTooltip>
              )}
            </div>
          ) : null}
        </header>

        {errorMessage ? (
          <div className="rounded-lg border border-token-error-border bg-token-error-background px-3 py-2 text-sm text-token-error-foreground">
            {errorMessage}
          </div>
        ) : null}

        {automation ? (
          <AutomationDetailSection title="Status">
            <AutomationDetailRow label="Status">
              <span className="truncate rounded-full bg-token-bg-secondary px-2.5 py-1 text-base text-token-text-primary">
                {formatAutomationStatus(draft.status)}
              </span>
            </AutomationDetailRow>
            <AutomationDetailRow label="Next run">
              <span className="truncate rounded-full bg-token-bg-secondary px-2.5 py-1 text-base text-token-text-primary">
                {formatCodexScheduledAutomationNextRunLabel(automation.nextRunAt)}
              </span>
            </AutomationDetailRow>
            <AutomationDetailRow label="Last ran">
              <span className="truncate rounded-full bg-token-bg-secondary px-2.5 py-1 text-base text-token-text-primary">
                {formatAutomationTimestamp(automation.lastRunAt)}
              </span>
            </AutomationDetailRow>
          </AutomationDetailSection>
        ) : null}

        <AutomationDetailSection title="Details">
          <AutomationDetailRow label="Runs in">
            <AutomationDropdownField
              ariaLabel="Execution environment"
              value={runInTarget}
              title="Run in"
              options={runInOptions.map((option) => ({
                value: option,
                label: runInTargetLabel(option),
              }))}
              disabled={isMutating}
              onValueChange={(value) => updateRunInTarget(value as "local" | "worktree" | "thread")}
            />
          </AutomationDetailRow>

          {draft.kind === "heartbeat" ? (
            <AutomationDetailRow label="Chat">
              <Input
                aria-label="Chat"
                value={draft.targetThreadId}
                disabled={isMutating}
                placeholder="Select chat"
                className={AUTOMATION_FIELD_INPUT_CLASS}
                onInput={(event) => updateDraft({ targetThreadId: event.currentTarget.value })}
              />
            </AutomationDetailRow>
          ) : (
            <>
              {draft.executionEnvironment === "worktree" && draft.cwds.length === 1 ? (
                <AutomationDetailRow label="Environment">
                  <AutomationEnvironmentDropdown
                    projects={projects}
                    selectedRoot={draft.cwds[0] ?? ""}
                    selectedConfigPath={draft.localEnvironmentConfigPath}
                    disabled={isMutating}
                    onSelectedConfigPathChange={(localEnvironmentConfigPath) =>
                      updateDraft({ localEnvironmentConfigPath })
                    }
                    onOpenSettings={onOpenLocalEnvironmentsSettings}
                  />
                </AutomationDetailRow>
              ) : null}
              <AutomationDetailRow label="Project">
                <AutomationProjectDropdown
                  projects={projects}
                  selectedRoots={draft.cwds}
                  disabled={isMutating}
                  onSelectedRootsChange={(cwds) => updateDraft({ cwds })}
                />
              </AutomationDetailRow>
            </>
          )}

          <AutomationDetailRow label={draft.kind === "heartbeat" ? "Interval" : "Repeats"}>
            <AutomationSchedulePopover
              rrule={draft.rrule}
              intervalStyle={scheduleIntervalStyle}
              disabled={isMutating}
              onRruleChange={(rrule) => updateDraft({ rrule })}
            />
          </AutomationDetailRow>

          {draft.kind === "cron" ? (
            <AutomationDetailRow label="Model">
              <AutomationModelReasoningDropdown
                draft={draft}
                models={codexModels}
                modelsLoading={codexModelsLoading}
                modelsError={codexModelsError}
                disabled={isMutating}
                onSelect={(model, reasoningEffort) =>
                  updateDraft({
                    model,
                    reasoningEffort,
                    serviceTier: "",
                  })
                }
              />
            </AutomationDetailRow>
          ) : null}
        </AutomationDetailSection>

        {automation && automation.kind === "cron" ? (
          <AutomationPreviousRunsSection
            rows={previousRunRows}
            loading={previousRunsLoading}
            actionBusy={isRunActionBusy}
            onOpenRun={onOpenRun}
            onArchiveRuns={onArchiveRuns}
            onUnarchiveRun={onUnarchiveRun}
            onMarkRunsRead={onMarkRunsRead}
            onMarkReadState={onMarkRunReadState}
          />
        ) : null}
      </form>
    </div>
  );
}

export interface WorkbenchAutomationSidePanelTabProps {
  automationId?: string | null;
  createInput?: CodexScheduledAutomationCreateInput | null;
  mode?: "open" | "suggested-create" | "suggested-update";
  projects: readonly Project[];
  title: string;
  updateInput?: CodexScheduledAutomationUpdateInput | null;
  onClose: () => void | Promise<void>;
  onOpenInScheduled: (automationId: string) => void | Promise<void>;
  onOpenLocalEnvironmentsSettings?: (input: {
    projectId: string | null;
    configPath: string | null;
  }) => void;
  onSaved?: (automation: CodexScheduledAutomation) => void;
  onTitleChange?: (title: string) => void;
}

const AUTOMATION_SIDE_PANEL_FORM_ID = "automation-side-panel-form";

export function WorkbenchAutomationSidePanelTab({
  automationId,
  createInput,
  mode = "open",
  projects,
  updateInput,
  onClose,
  onOpenInScheduled,
  onOpenLocalEnvironmentsSettings,
  onSaved,
  onTitleChange,
}: WorkbenchAutomationSidePanelTabProps) {
  const queryClient = useQueryClient();
  const automationsQuery = useCodexScheduledAutomations();
  const modelsQuery = useQuery(codexModelsListQueryOptions());
  const [savedAutomation, setSavedAutomation] = useState<CodexScheduledAutomation | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const targetAutomationId = updateInput?.id ?? automationId ?? null;
  const automations = automationsQuery.data ?? [];
  const targetAutomation =
    savedAutomation ??
    (targetAutomationId
      ? (automations.find((automation) => automation.id === targetAutomationId) ?? null)
      : null);
  const isProposal =
    savedAutomation === null && (mode === "suggested-create" || mode === "suggested-update");
  const isSuggestedUpdate = isProposal && mode === "suggested-update";
  const draftSeed = useMemo(() => {
    if (!isProposal) return null;
    if (mode === "suggested-create") {
      return createInput ? createWorkbenchAutomationDraftFromCreateInput(createInput) : null;
    }
    if (!updateInput) return null;
    return createWorkbenchAutomationDraftFromUpdateInput({
      update: updateInput,
      automation: targetAutomation,
    });
  }, [createInput, isProposal, mode, targetAutomation, updateInput]);
  const effectiveAutomation = targetAutomation;
  const effectiveMode = isProposal && mode === "suggested-create" ? "create" : "edit";
  const createEditorDraft = () => {
    const baseDraft = draftSeed
      ? cloneWorkbenchAutomationDraft(draftSeed)
      : createWorkbenchAutomationDraft({
          automation: effectiveMode === "create" ? null : effectiveAutomation,
        });
    return modelsQuery.data
      ? resolveWorkbenchAutomationDraftModelSettings({
          draft: baseDraft,
          models: modelsQuery.data,
        })
      : baseDraft;
  };
  const [draft, setDraft] = useState<WorkbenchAutomationDraft>(() => createEditorDraft());
  const resetEditorDraft = useEffectEvent(() => {
    setDraft(createEditorDraft());
  });
  const validation = validateWorkbenchAutomationDraft(draft);
  const dirty = isWorkbenchAutomationDraftDirty({
    draft,
    existing: effectiveMode === "create" ? null : effectiveAutomation,
  });
  const onTitleChangeRef = useRef(onTitleChange);
  const lastTitleRef = useRef<string | null>(null);

  useEffect(() => {
    resetEditorDraft();
  }, [effectiveAutomation?.id, draftSeed?.id, effectiveMode]);

  useEffect(() => {
    if (!modelsQuery.data) return;
    setDraft((current) =>
      resolveWorkbenchAutomationDraftModelSettings({
        draft: current,
        models: modelsQuery.data ?? [],
      }),
    );
  }, [modelsQuery.data]);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    const nextTitle = draft.name.trim();
    if (nextTitle.length === 0 || nextTitle === lastTitleRef.current) return;
    lastTitleRef.current = nextTitle;
    onTitleChangeRef.current?.(nextTitle);
  }, [draft.name]);

  const upsertSavedAutomation = async (automation: CodexScheduledAutomation) => {
    queryClient.setQueryData<CodexScheduledAutomation[]>(
      queryKeys.codexScheduledAutomations.list(),
      (current) => upsertAutomationInList(current, automation),
    );
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.codexScheduledAutomations.list(),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.codexAutomationRuns.all(),
      }),
    ]);
    setSavedAutomation(automation);
    setMutationError(null);
    onSaved?.(automation);
    onTitleChange?.(automation.name);
  };

  const saveAutomation = async (draft: WorkbenchAutomationDraft) => {
    const shouldUpdate = mode === "suggested-update" || (!isProposal && targetAutomation !== null);
    const updatePayload = shouldUpdate
      ? buildCodexScheduledAutomationUpdateInput({
          draft,
          id: targetAutomation?.id ?? updateInput?.id ?? draft.id,
        })
      : null;
    const createPayload = shouldUpdate ? null : buildCodexScheduledAutomationCreateInput({ draft });
    if (shouldUpdate && !updatePayload) return;
    if (!shouldUpdate && !createPayload) return;

    setMutating(true);
    setMutationError(null);
    const scheduledQueryKey = queryKeys.codexScheduledAutomations.list();
    const previousAutomations = shouldUpdate
      ? queryClient.getQueryData<CodexScheduledAutomation[]>(scheduledQueryKey)
      : undefined;
    if (shouldUpdate && updatePayload) {
      queryClient.setQueryData<CodexScheduledAutomation[]>(scheduledQueryKey, (current) =>
        applyOptimisticAutomationUpdate(current, updatePayload),
      );
    }
    try {
      const response = shouldUpdate
        ? await updateCodexScheduledAutomation(updatePayload as CodexScheduledAutomationUpdateInput)
        : await createCodexScheduledAutomation(
            createPayload as CodexScheduledAutomationCreateInput,
          );
      await upsertSavedAutomation(response.item);
    } catch (error) {
      if (previousAutomations) {
        queryClient.setQueryData(scheduledQueryKey, previousAutomations);
      }
      const title = shouldUpdate
        ? "Could not update scheduled task"
        : "Could not create scheduled task";
      const description = showAutomationMutationErrorToast(title, error);
      setMutationError(description ?? `${title}.`);
    } finally {
      setMutating(false);
    }
  };
  const autoSaveAutomation = useEffectEvent((nextDraft: WorkbenchAutomationDraft) =>
    saveAutomation(nextDraft),
  );

  useEffect(() => {
    if (isProposal) return;
    if (effectiveMode !== "edit" || effectiveAutomation === null) return;
    if (!validation.canSave || !dirty || mutating) return;
    const timeout = window.setTimeout(() => {
      void autoSaveAutomation(draft);
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [dirty, draft, effectiveAutomation, effectiveMode, isProposal, mutating, validation.canSave]);

  if (
    isSuggestedUpdate &&
    targetAutomationId !== null &&
    targetAutomation === null &&
    automationsQuery.isLoading
  ) {
    return (
      <AutomationsEmptyState
        icon={<AutomationLoadingIcon className="icon-sm" />}
        title="Loading scheduled task"
        description="Reading the latest automation metadata for this workspace."
      />
    );
  }

  if (isSuggestedUpdate && targetAutomationId !== null && targetAutomation === null) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary p-panel">
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <span className="flex size-10 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary">
              <AutomationTemplateColorIcon iconName="exclamationmark-bubble" className="icon-sm" />
            </span>
            <div className="text-lg text-token-foreground">Scheduled task unavailable</div>
            <div className="text-sm text-token-description-foreground">
              This scheduled task may have been deleted or is no longer available on this machine.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isProposal && !draftSeed) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary p-panel">
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <span className="flex size-10 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary">
              <AutomationTemplateColorIcon iconName="exclamationmark-bubble" className="icon-sm" />
            </span>
            <div className="text-lg text-token-foreground">Scheduled task unavailable</div>
            <div className="text-sm text-token-description-foreground">
              This scheduled task proposal is missing required fields.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const canSubmit = (effectiveMode === "create" || isProposal) && validation.canSave && !mutating;
  const proposalTooltip = formatWorkbenchAutomationDraftSaveTooltip({
    draft,
    action: mode === "suggested-update" ? "save" : "create",
  });
  const acceptedAutomationId = savedAutomation?.id ?? targetAutomation?.id ?? automationId ?? null;
  const acceptLabel = mode === "suggested-update" ? "Apply changes" : "Create scheduled task";

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-token-main-surface-primary"
      data-automation-side-panel-tab="true"
    >
      <AutomationDraftEditor
        automation={effectiveMode === "create" ? null : effectiveAutomation}
        projects={projects}
        mode={effectiveMode}
        draft={draft}
        setDraft={setDraft}
        validation={validation}
        createDraftTemplate={null}
        codexModels={modelsQuery.data ?? []}
        codexModelsLoading={modelsQuery.isLoading}
        codexModelsError={modelsQuery.isError}
        formId={AUTOMATION_SIDE_PANEL_FORM_ID}
        manualSubmit={isProposal}
        showHeaderCreateAction={false}
        previousRunRows={[]}
        previousRunsLoading={false}
        onSave={saveAutomation}
        onArchiveRuns={async () => undefined}
        onUnarchiveRun={() => undefined}
        onMarkRunsRead={async () => undefined}
        onMarkRunReadState={() => undefined}
        onOpenLocalEnvironmentsSettings={onOpenLocalEnvironmentsSettings}
        isMutating={mutating}
        isTemplatePersonalizationPending={false}
        isRunActionBusy={false}
        errorMessage={mutationError}
      />
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-token-border p-panel">
        {isProposal ? (
          <>
            <NodexButton
              type="button"
              variant="ghost"
              size="sm"
              disabled={mutating}
              onClick={() => void onClose()}
            >
              Cancel
            </NodexButton>
            <NodexTooltip
              tooltipContent={proposalTooltip}
              disabled={proposalTooltip === null}
              delayOpen
            >
              <span className="inline-flex">
                <NodexButton
                  type="submit"
                  form={AUTOMATION_SIDE_PANEL_FORM_ID}
                  variant="secondary"
                  size="sm"
                  disabled={!canSubmit}
                  className={canSubmit ? undefined : "pointer-events-none"}
                >
                  {mutating ? <AutomationLoadingIcon className="icon-xs" /> : null}
                  {acceptLabel}
                </NodexButton>
              </span>
            </NodexTooltip>
          </>
        ) : (
          <NodexButton
            type="button"
            variant="secondary"
            size="sm"
            disabled={!acceptedAutomationId}
            onClick={() => {
              if (!acceptedAutomationId) return;
              void onOpenInScheduled(acceptedAutomationId);
            }}
          >
            Open in Scheduled
          </NodexButton>
        )}
      </div>
    </div>
  );
}

export function WorkbenchAutomationsRouteShell({
  path,
  projects = EMPTY_AUTOMATION_PROJECTS,
  externalHeader = false,
  detailRailPortalTarget = null,
  onDetailRailOpenChange,
  onPathChange,
  onOpenThread,
  onCreateWithChat,
  onPersonalizeTemplate,
  onOpenLocalEnvironmentsSettings,
}: WorkbenchAutomationsRouteShellProps) {
  const queryClient = useQueryClient();
  const routeState = resolveAutomationsRouteState(path);
  const automationsQuery = useCodexScheduledAutomations();
  const automationRunsQuery = useCodexAutomationRunsInbox();
  const modelsQuery = useQuery(codexModelsListQueryOptions());
  const [mutatingAutomationId, setMutatingAutomationId] = useState<string | null>(null);
  const [runNowPendingAutomationId, setRunNowPendingAutomationId] = useState<string | null>(null);
  const [runActionPending, setRunActionPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [deleteDialogAutomation, setDeleteDialogAutomation] =
    useState<CodexScheduledAutomation | null>(null);
  const [createDraftSeed, setCreateDraftSeed] = useState<WorkbenchAutomationDraft | null>(null);
  const [createDraftTemplate, setCreateDraftTemplate] =
    useState<WorkbenchAutomationTemplate | null>(null);
  const [chatCreatePending, setChatCreatePending] = useState(false);
  const [templatePersonalizationPending, setTemplatePersonalizationPending] = useState(false);
  const [dispageDraftDialogOpen, setDispageDraftDialogOpen] = useState(false);
  const pendingDiscardActionRef = useRef<(() => void) | null>(null);
  const pendingEditActionRef = useRef<{
    action: () => void | Promise<void>;
    update: CodexScheduledAutomationUpdateInput;
  } | null>(null);
  const editGuardSaveInFlightRef = useRef(false);
  const failedEditUpdateRef = useRef<CodexScheduledAutomationUpdateInput | null>(null);
  const automations = sortCodexScheduledAutomationsForDisplay(automationsQuery.data ?? []);
  const unreadAutomationIds = useMemo(
    () => new Set(automationRunsQuery.data?.unreadRunCounts.automationIds ?? []),
    [automationRunsQuery.data?.unreadRunCounts.automationIds],
  );
  const runningAutomationIds = useMemo(
    () =>
      new Set(
        (automationRunsQuery.data?.items ?? [])
          .filter((item) => item.status === "IN_PROGRESS")
          .map((item) => item.automationId),
      ),
    [automationRunsQuery.data?.items],
  );
  const selectedAutomation =
    routeState.automationId === null
      ? null
      : (automations.find((automation) => automation.id === routeState.automationId) ?? null);
  const previousRunRows = useMemo(() => {
    if (!selectedAutomation || selectedAutomation.kind !== "cron") return [];
    return buildWorkbenchAutomationPreviousRunRows({
      items: automationRunsQuery.data?.items ?? [],
      automationId: selectedAutomation.id,
    });
  }, [automationRunsQuery.data?.items, selectedAutomation]);
  const detailMode =
    routeState.automationMode === "create"
      ? "create"
      : routeState.automationId === null
        ? null
        : selectedAutomation === null
          ? automationsQuery.isLoading || automationsQuery.isFetching
            ? "loading"
            : "missing"
          : "edit";
  const detailRailOpen = detailMode !== null;
  const createRouteDraft = () => {
    const baseDraft =
      detailMode === "create"
        ? createDraftSeed
          ? cloneWorkbenchAutomationDraft(createDraftSeed)
          : createWorkbenchAutomationDraft()
        : selectedAutomation
          ? createWorkbenchAutomationDraft({ automation: selectedAutomation })
          : createWorkbenchAutomationDraft();
    return modelsQuery.data
      ? resolveWorkbenchAutomationDraftModelSettings({
          draft: baseDraft,
          models: modelsQuery.data,
        })
      : baseDraft;
  };
  const [draft, setDraft] = useState<WorkbenchAutomationDraft>(() => createRouteDraft());
  const [initialCreateDraft, setInitialCreateDraft] = useState<WorkbenchAutomationDraft | null>(
    () => (detailMode === "create" ? cloneWorkbenchAutomationDraft(createRouteDraft()) : null),
  );
  const resetRouteDraft = useEffectEvent(() => {
    const nextDraft = createRouteDraft();
    setDraft(nextDraft);
    setInitialCreateDraft(
      detailMode === "create" ? cloneWorkbenchAutomationDraft(nextDraft) : null,
    );
    failedEditUpdateRef.current = null;
    pendingEditActionRef.current = null;
  });
  const draftValidation = validateWorkbenchAutomationDraft(draft);
  const editDraftDirty =
    detailMode === "edit" && selectedAutomation !== null
      ? isWorkbenchAutomationDraftDirty({ draft, existing: selectedAutomation })
      : false;
  const createDraftDirty =
    detailMode === "create" && hasWorkbenchAutomationCreateDraftChanges(draft, initialCreateDraft);
  const editUpdateInput = useMemo(
    () =>
      detailMode === "edit" && selectedAutomation !== null && draftValidation.canSave
        ? buildCodexScheduledAutomationUpdateInput({
            draft,
            id: selectedAutomation.id,
          })
        : null,
    [detailMode, draft, draftValidation.canSave, selectedAutomation],
  );
  const pendingEditUpdateInput = editDraftDirty ? editUpdateInput : null;

  useLayoutEffect(() => {
    onDetailRailOpenChange?.(detailRailOpen);
    return () => {
      onDetailRailOpenChange?.(false);
    };
  }, [detailRailOpen, onDetailRailOpenChange]);

  useEffect(() => {
    resetRouteDraft();
  }, [detailMode, selectedAutomation?.id, createDraftSeed?.id]);

  useEffect(() => {
    if (!modelsQuery.data) return;
    setDraft((current) =>
      resolveWorkbenchAutomationDraftModelSettings({
        draft: current,
        models: modelsQuery.data ?? [],
      }),
    );
    setInitialCreateDraft((current) =>
      current
        ? resolveWorkbenchAutomationDraftModelSettings({
            draft: current,
            models: modelsQuery.data ?? [],
          })
        : current,
    );
  }, [modelsQuery.data]);

  useEffect(() => {
    if (detailMode === "create") return;
    setCreateDraftSeed(null);
    setCreateDraftTemplate(null);
    setDispageDraftDialogOpen(false);
    pendingDiscardActionRef.current = null;
  }, [detailMode]);

  const createWithChat = async (prompt: string = WORKBENCH_AUTOMATION_CREATE_WITH_CHAT_PROMPT) => {
    if (!onCreateWithChat || chatCreatePending) return;
    setMutationError(null);
    setChatCreatePending(true);
    try {
      await onCreateWithChat(prompt);
      setMutationError(null);
    } catch (error) {
      const description = error instanceof Error ? error.message : undefined;
      setMutationError(description ?? "Could not start scheduled task chat.");
      toast.danger("Could not start scheduled task chat", {
        description,
      });
    } finally {
      setChatCreatePending(false);
    }
  };

  const personalizeTemplate = async (template: WorkbenchAutomationTemplate) => {
    if (!onPersonalizeTemplate || templatePersonalizationPending) return;
    setMutationError(null);
    setTemplatePersonalizationPending(true);
    try {
      await onPersonalizeTemplate(buildWorkbenchAutomationTemplatePersonalizationPrompt(template));
      setMutationError(null);
    } catch (error) {
      const description = error instanceof Error ? error.message : undefined;
      setMutationError(description ?? "Could not start personalization with Nodex.");
      toast.danger("Could not start personalization with Nodex", {
        description,
      });
    } finally {
      setTemplatePersonalizationPending(false);
    }
  };

  const invalidateAutomationReadModels = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.codexScheduledAutomations.list(),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.codexAutomationRuns.all(),
      }),
    ]);
  };

  const saveAutomationUpdateInput = async (
    updateInput: CodexScheduledAutomationUpdateInput,
    options: { trackFailedEdit?: boolean } = {},
  ): Promise<boolean> => {
    setMutationError(null);
    const scheduledQueryKey = queryKeys.codexScheduledAutomations.list();
    const previousAutomations =
      queryClient.getQueryData<CodexScheduledAutomation[]>(scheduledQueryKey);
    setMutatingAutomationId(updateInput.id);
    queryClient.setQueryData<CodexScheduledAutomation[]>(scheduledQueryKey, (current) =>
      applyOptimisticAutomationUpdate(current, updateInput),
    );
    try {
      const response = await updateCodexScheduledAutomation(
        updateInput satisfies CodexScheduledAutomationUpdateInput,
      );
      const saved = response.item;
      queryClient.setQueryData<CodexScheduledAutomation[]>(scheduledQueryKey, (current) =>
        upsertAutomationInList(current, saved),
      );
      await invalidateAutomationReadModels();
      if (areAutomationUpdateInputsEqual(failedEditUpdateRef.current, updateInput)) {
        failedEditUpdateRef.current = null;
      }
      setMutationError(null);
      return true;
    } catch (error) {
      if (previousAutomations) {
        queryClient.setQueryData(scheduledQueryKey, previousAutomations);
      }
      if (options.trackFailedEdit === true) {
        failedEditUpdateRef.current = updateInput;
      }
      const title = "Could not update scheduled task";
      const description = showAutomationMutationErrorToast(title, error);
      setMutationError(description ?? `${title}.`);
      return false;
    } finally {
      setMutatingAutomationId(null);
    }
  };

  const saveAutomationCreateInput = async (
    createInput: CodexScheduledAutomationCreateInput,
    draftId: string | null,
  ): Promise<boolean> => {
    setMutationError(null);
    setMutatingAutomationId(draftId ?? "new-automation");
    try {
      const response = await createCodexScheduledAutomation(
        createInput satisfies CodexScheduledAutomationCreateInput,
      );
      const saved = response.item;
      queryClient.setQueryData<CodexScheduledAutomation[]>(
        queryKeys.codexScheduledAutomations.list(),
        (current) => upsertAutomationInList(current, saved),
      );
      await invalidateAutomationReadModels();
      setMutationError(null);
      setCreateDraftSeed(null);
      setCreateDraftTemplate(null);
      onPathChange(
        buildAutomationsPath({
          tab: "tasks",
          automationId: saved.id,
        }),
      );
      return true;
    } catch (error) {
      const title = "Could not create scheduled task";
      const description = showAutomationMutationErrorToast(title, error);
      setMutationError(description ?? `${title}.`);
      return false;
    } finally {
      setMutatingAutomationId(null);
    }
  };

  const saveAutomation = async (nextDraft: WorkbenchAutomationDraft): Promise<boolean> => {
    if (detailMode === "edit") {
      if (selectedAutomation === null) return false;
      const updateInput = buildCodexScheduledAutomationUpdateInput({
        draft: nextDraft,
        id: selectedAutomation.id,
      });
      if (!updateInput) return false;
      return saveAutomationUpdateInput(updateInput, { trackFailedEdit: true });
    }

    if (detailMode !== "create") return false;

    const createInput = buildCodexScheduledAutomationCreateInput({ draft: nextDraft });
    if (!createInput) return false;
    return saveAutomationCreateInput(createInput, nextDraft.id);
  };

  const getPendingEditUpdateInput = () => {
    if (detailMode !== "edit" || selectedAutomation === null) return null;
    return pendingEditUpdateInput;
  };

  const flushPendingEditAction = () => {
    const pending = pendingEditActionRef.current;
    if (!pending) return;
    if (mutatingAutomationId !== null || editGuardSaveInFlightRef.current) return;

    editGuardSaveInFlightRef.current = true;
    const updateToSave = pending.update;
    void saveAutomationUpdateInput(updateToSave, { trackFailedEdit: true })
      .then((saved) => {
        if (!saved) return;
        const latestPending = pendingEditActionRef.current;
        if (!latestPending) return;
        if (!areAutomationUpdateInputsEqual(latestPending.update, updateToSave)) return;
        pendingEditActionRef.current = null;
        void latestPending.action();
      })
      .finally(() => {
        editGuardSaveInFlightRef.current = false;
        const latestPending = pendingEditActionRef.current;
        if (latestPending && !areAutomationUpdateInputsEqual(latestPending.update, updateToSave)) {
          flushPendingEditAction();
        }
      });
  };

  const runAfterEditSaveGuard = (action: () => void | Promise<void>) => {
    const pendingUpdate = getPendingEditUpdateInput();
    if (!pendingUpdate) {
      void action();
      return;
    }

    pendingEditActionRef.current = {
      action,
      update: pendingUpdate,
    };
    flushPendingEditAction();
  };
  const refreshPendingEditAction = useEffectEvent(() => {
    if (!pendingEditActionRef.current) return;
    const pendingUpdate = getPendingEditUpdateInput();
    if (!pendingUpdate) return;
    pendingEditActionRef.current = {
      ...pendingEditActionRef.current,
      update: pendingUpdate,
    };
    flushPendingEditAction();
  });
  const persistPendingEditUpdate = useEffectEvent((update: CodexScheduledAutomationUpdateInput) =>
    saveAutomationUpdateInput(update, { trackFailedEdit: true }),
  );

  useEffect(() => {
    refreshPendingEditAction();
  }, [mutatingAutomationId, pendingEditUpdateInput]);

  useEffect(() => {
    if (!failedEditUpdateRef.current) return;
    if (areAutomationUpdateInputsEqual(failedEditUpdateRef.current, pendingEditUpdateInput)) return;
    failedEditUpdateRef.current = null;
  }, [pendingEditUpdateInput]);

  useEffect(() => {
    if (!pendingEditUpdateInput) return;
    if (mutatingAutomationId !== null || editGuardSaveInFlightRef.current) return;
    if (areAutomationUpdateInputsEqual(failedEditUpdateRef.current, pendingEditUpdateInput)) return;

    const timeout = window.setTimeout(() => {
      if (areAutomationUpdateInputsEqual(failedEditUpdateRef.current, pendingEditUpdateInput))
        return;
      void persistPendingEditUpdate(pendingEditUpdateInput);
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [mutatingAutomationId, pendingEditUpdateInput]);

  const runAfterCreateDiscardGuard = (action: () => void | Promise<void>) => {
    if (detailMode !== "create" || !createDraftDirty) {
      void action();
      return;
    }

    pendingDiscardActionRef.current = () => {
      void action();
    };
    setDispageDraftDialogOpen(true);
  };

  const runAfterAutomationRouteGuard = (action: () => void | Promise<void>) => {
    if (detailMode === "create") {
      runAfterCreateDiscardGuard(action);
      return;
    }

    runAfterEditSaveGuard(action);
  };

  const findAutomationSnapshotById = (automationId: string): CodexScheduledAutomation | null => {
    const scheduledQueryKey = queryKeys.codexScheduledAutomations.list();
    const cachedAutomations =
      queryClient.getQueryData<CodexScheduledAutomation[]>(scheduledQueryKey) ?? [];
    return (
      cachedAutomations.find((automation) => automation.id === automationId) ??
      automations.find((automation) => automation.id === automationId) ??
      null
    );
  };

  const openAutomation = (automation: CodexScheduledAutomation) => {
    runAfterAutomationRouteGuard(() => {
      setMutationError(null);
      onPathChange(
        buildAutomationsPath({
          tab: "tasks",
          automationId: automation.id,
        }),
      );
    });
  };

  const selectPageTab = (tab: WorkbenchAutomationsTab) => {
    runAfterAutomationRouteGuard(() => {
      setMutationError(null);
      onPathChange(buildAutomationsPath({ tab }));
    });
  };

  const openCreateMode = () => {
    if (detailMode === "create") return;
    runAfterAutomationRouteGuard(() => {
      setMutationError(null);
      setCreateDraftSeed(null);
      setCreateDraftTemplate(null);
      onPathChange(
        buildAutomationsPath({
          tab: "tasks",
          automationId: null,
          automationMode: "create",
        }),
      );
    });
  };

  const backToList = () => {
    runAfterAutomationRouteGuard(() => {
      setMutationError(null);
      onPathChange(buildAutomationsPath({ tab: routeState.tab }));
    });
  };

  const selectTemplate = (template: WorkbenchAutomationTemplate) => {
    runAfterAutomationRouteGuard(() => {
      setMutationError(null);
      setCreateDraftSeed(createWorkbenchAutomationDraftFromTemplate(template));
      setCreateDraftTemplate(template);
      onPathChange(
        buildAutomationsPath({
          tab: "templates",
          automationId: null,
          automationMode: "create",
        }),
      );
    });
  };

  const requestCreateWithChat = (prompt: string = WORKBENCH_AUTOMATION_CREATE_WITH_CHAT_PROMPT) => {
    runAfterAutomationRouteGuard(() => createWithChat(prompt));
  };

  const requestOpenLocalEnvironmentsSettings = onOpenLocalEnvironmentsSettings
    ? (input: { projectId: string | null; configPath: string | null }) => {
        runAfterAutomationRouteGuard(() => onOpenLocalEnvironmentsSettings(input));
      }
    : undefined;

  const deleteAutomation = async (automation: CodexScheduledAutomation) => {
    setMutationError(null);
    setMutatingAutomationId(automation.id);
    try {
      const response = await deleteCodexScheduledAutomation({
        id: automation.id,
      });
      if (!response.success) {
        setMutationError("Could not delete scheduled task.");
        await queryClient.invalidateQueries({
          queryKey: queryKeys.codexScheduledAutomations.list(),
        });
        toast.danger("Could not delete scheduled task", {
          description: "Try again.",
        });
        return;
      }
      queryClient.setQueryData<CodexScheduledAutomation[]>(
        queryKeys.codexScheduledAutomations.list(),
        (current) => deleteAutomationFromList(current, automation.id),
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeys.codexScheduledAutomations.list(),
      });
      setMutationError(null);
      if (routeState.automationId === automation.id) {
        onPathChange(buildAutomationsPath({ tab: routeState.tab }));
      }
    } catch (error) {
      const description = showAutomationMutationErrorToast(
        "Could not delete scheduled task",
        error,
      );
      setMutationError(description ?? "Could not delete scheduled task.");
    } finally {
      setMutatingAutomationId(null);
    }
  };

  const updateAutomationStatus = async (
    automation: CodexScheduledAutomation,
    status: CodexScheduledAutomation["status"],
  ) => {
    setMutationError(null);
    setMutatingAutomationId(automation.id);
    const updateInput = buildAutomationStatusUpdateInput(automation, status);
    const scheduledQueryKey = queryKeys.codexScheduledAutomations.list();
    const previousAutomations =
      queryClient.getQueryData<CodexScheduledAutomation[]>(scheduledQueryKey);
    queryClient.setQueryData<CodexScheduledAutomation[]>(scheduledQueryKey, (current) =>
      applyOptimisticAutomationUpdate(current, updateInput),
    );
    try {
      const response = await updateCodexScheduledAutomation(updateInput);
      queryClient.setQueryData<CodexScheduledAutomation[]>(scheduledQueryKey, (current) =>
        upsertAutomationInList(current, response.item),
      );
      await queryClient.invalidateQueries({
        queryKey: scheduledQueryKey,
      });
      setMutationError(null);
    } catch (error) {
      if (previousAutomations) {
        queryClient.setQueryData(scheduledQueryKey, previousAutomations);
      }
      const description = showAutomationMutationErrorToast(
        "Could not update scheduled task",
        error,
      );
      setMutationError(description ?? "Could not update scheduled task.");
    } finally {
      setMutatingAutomationId(null);
    }
  };

  const runAutomationNow = async (automation: CodexScheduledAutomation) => {
    if (runNowPendingAutomationId !== null) return;
    setMutationError(null);
    setRunNowPendingAutomationId(automation.id);
    try {
      await runCodexScheduledAutomationNow({
        id: automation.id,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.codexScheduledAutomations.list(),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.codexAutomationRuns.inbox(200),
        }),
      ]);
      setMutationError(null);
      toast.info("Scheduled task started");
    } catch (error) {
      const description = error instanceof Error ? error.message : undefined;
      setMutationError(description ?? "Could not start scheduled task.");
      toast.danger("Could not start scheduled task", {
        description,
      });
    } finally {
      setRunNowPendingAutomationId(null);
    }
  };

  const invalidateAutomationRunsInbox = async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.codexAutomationRuns.inbox(200),
    });
  };

  const archiveAutomationRuns = async (
    rows: WorkbenchAutomationPreviousRunRowModel[],
    options: { showSuccessToast?: boolean } = {},
  ) => {
    if (rows.length === 0 || runActionPending) return;
    setMutationError(null);
    setRunActionPending(true);
    try {
      let failedCount = 0;
      for (const row of rows) {
        const response = await archiveCodexAutomationRun({
          threadId: row.threadId,
          archivedReason: "manual",
        });
        if (!response.success) failedCount += 1;
      }
      await invalidateAutomationRunsInbox();
      if (failedCount > 0) {
        const message =
          failedCount === rows.length
            ? "Could not archive run"
            : `Archived ${rows.length - failedCount}; ${failedCount} failed`;
        setMutationError(message);
        toast.danger(message);
        return;
      }
      setMutationError(null);
      if (options.showSuccessToast === true) {
        toast.success(rows.length === 1 ? "Archived 1 run" : `Archived ${rows.length} runs`);
      }
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Could not archive run.");
      toast.danger("Could not archive run");
    } finally {
      setRunActionPending(false);
    }
  };

  const unarchiveAutomationRun = async (row: WorkbenchAutomationPreviousRunRowModel) => {
    if (runActionPending) return;
    setMutationError(null);
    setRunActionPending(true);
    try {
      const response = await unarchiveCodexAutomationRun({
        threadId: row.threadId,
      });
      await invalidateAutomationRunsInbox();
      if (!response.success) {
        setMutationError("Failed to unarchive chat.");
        toast.danger("Failed to unarchive chat");
        return;
      }
      setMutationError(null);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Failed to unarchive chat.");
      toast.danger("Failed to unarchive chat");
    } finally {
      setRunActionPending(false);
    }
  };

  const setAutomationRunsReadState = async (
    rows: WorkbenchAutomationPreviousRunRowModel[],
    readAt: number | null,
  ) => {
    if (rows.length === 0 || runActionPending) return;
    setMutationError(null);
    setRunActionPending(true);
    try {
      for (const row of rows) {
        await setCodexAutomationRunReadState({
          threadId: row.threadId,
          readAt,
        });
      }
      await invalidateAutomationRunsInbox();
      setMutationError(null);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Could not update run read state.");
    } finally {
      setRunActionPending(false);
    }
  };

  const setAutomationRunReadState = (
    row: WorkbenchAutomationPreviousRunRowModel,
    readAt: number | null,
  ) => {
    void setAutomationRunsReadState([row], readAt);
  };

  const openAutomationRun = (row: WorkbenchAutomationPreviousRunRowModel) => {
    if (!row.canOpen || !onOpenThread) return;
    runAfterAutomationRouteGuard(() => {
      void onOpenThread(row.threadId);
    });
  };

  const requestRunAutomationNow = (automation: CodexScheduledAutomation) => {
    runAfterAutomationRouteGuard(() => {
      const latestAutomation = findAutomationSnapshotById(automation.id) ?? automation;
      void runAutomationNow(latestAutomation);
    });
  };

  const requestUpdateAutomationStatus = (
    automation: CodexScheduledAutomation,
    status: CodexScheduledAutomation["status"],
  ) => {
    runAfterAutomationRouteGuard(() => {
      const latestAutomation = findAutomationSnapshotById(automation.id);
      if (!latestAutomation) {
        setMutationError("Could not update scheduled task.");
        toast.danger("Could not update scheduled task", {
          description: "This scheduled task is no longer available.",
        });
        return;
      }
      void updateAutomationStatus(latestAutomation, status);
    });
  };

  const requestDeleteAutomationFromRow = (automation: CodexScheduledAutomation) => {
    runAfterAutomationRouteGuard(() => {
      setDeleteDialogAutomation(findAutomationSnapshotById(automation.id) ?? automation);
    });
  };

  const closeDeleteDialog = () => {
    if (mutatingAutomationId !== null) return;
    setDeleteDialogAutomation(null);
  };

  const confirmDeleteDialog = async () => {
    if (!deleteDialogAutomation) return;
    const target = deleteDialogAutomation;
    await deleteAutomation(target);
    setDeleteDialogAutomation(null);
  };

  const closeDispageDraftDialog = () => {
    pendingDiscardActionRef.current = null;
    setDispageDraftDialogOpen(false);
  };

  const discardCreateDraft = () => {
    const action = pendingDiscardActionRef.current;
    pendingDiscardActionRef.current = null;
    setDispageDraftDialogOpen(false);
    action?.();
  };

  const routeHeader = (
    <AutomationsRouteHeader
      selectedTab={routeState.tab}
      detailMode={detailMode}
      placement={externalHeader ? "shell" : "inline"}
      onSelectTab={selectPageTab}
      onCreateManually={openCreateMode}
      onCreateWithChat={onCreateWithChat ? () => requestCreateWithChat() : undefined}
    />
  );

  const detailRailContent =
    detailMode !== null ? (
      <div className="h-full min-h-0 min-w-0 overflow-hidden [contain:layout_paint]">
        <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary">
          <div className="flex h-toolbar min-w-0 shrink-0 items-center justify-end px-panel">
            <div className="flex shrink-0 items-center gap-1.5">
              {detailMode === "edit" && selectedAutomation ? (
                <>
                  <AutomationDetailRunNowButton
                    disabled={runNowPendingAutomationId !== null || mutatingAutomationId !== null}
                    pending={runNowPendingAutomationId === selectedAutomation.id}
                    onClick={() => requestRunAutomationNow(selectedAutomation)}
                  />
                  {selectedAutomation.status === "PAUSED" ? (
                    <AutomationDetailToolbarButton
                      label="Resume scheduled task"
                      disabled={mutatingAutomationId !== null}
                      onClick={() => requestUpdateAutomationStatus(selectedAutomation, "ACTIVE")}
                    >
                      <AutomationResumeIcon className="icon-sm" />
                    </AutomationDetailToolbarButton>
                  ) : (
                    <AutomationDetailToolbarButton
                      label="Pause scheduled task"
                      disabled={mutatingAutomationId !== null}
                      onClick={() => requestUpdateAutomationStatus(selectedAutomation, "PAUSED")}
                    >
                      <AutomationPauseIcon className="icon-sm" />
                    </AutomationDetailToolbarButton>
                  )}
                  <AutomationDetailToolbarButton
                    label="Delete scheduled task"
                    disabled={mutatingAutomationId !== null}
                    danger
                    onClick={() => requestDeleteAutomationFromRow(selectedAutomation)}
                  >
                    <DeleteIcon className="icon-sm" />
                  </AutomationDetailToolbarButton>
                </>
              ) : null}
              <AutomationDetailToolbarButton label="Collapse details" active onClick={backToList}>
                <PanelRightVisibleIcon className="icon-sm" />
              </AutomationDetailToolbarButton>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <AutomationDetailSurface
              automation={selectedAutomation}
              projects={projects}
              selectedAutomationId={routeState.automationId}
              mode={detailMode}
              draft={draft}
              setDraft={setDraft}
              validation={draftValidation}
              createDraftTemplate={detailMode === "create" ? createDraftTemplate : null}
              codexModels={modelsQuery.data ?? []}
              codexModelsLoading={modelsQuery.isLoading}
              codexModelsError={modelsQuery.isError}
              previousRunRows={previousRunRows}
              previousRunsLoading={automationRunsQuery.isLoading || automationRunsQuery.isFetching}
              loading={automationsQuery.isLoading}
              onBackToList={backToList}
              onSave={async (draft) => {
                await saveAutomation(draft);
              }}
              onPersonalizeTemplate={onPersonalizeTemplate ? personalizeTemplate : undefined}
              onOpenRun={openAutomationRun}
              onArchiveRuns={archiveAutomationRuns}
              onUnarchiveRun={(row) => void unarchiveAutomationRun(row)}
              onMarkRunsRead={(rows, readAt) => setAutomationRunsReadState(rows, readAt)}
              onMarkRunReadState={setAutomationRunReadState}
              onOpenLocalEnvironmentsSettings={requestOpenLocalEnvironmentsSettings}
              isMutating={mutatingAutomationId !== null}
              isTemplatePersonalizationPending={templatePersonalizationPending}
              isRunActionBusy={runActionPending}
              errorMessage={mutationError}
            />
          </div>
        </div>
      </div>
    ) : null;

  const inlineDetailRail =
    detailRailContent && !externalHeader && detailRailPortalTarget === null ? (
      <aside
        data-testid="automation-detail-rail"
        data-right-panel-width-mode="regular"
        className="relative z-[41] ml-auto h-full min-h-0 w-[min(820px,50vw)] min-w-0 shrink-0 overflow-visible"
      >
        <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden">
          <div className="absolute top-0 bottom-0 left-0 min-w-0 border-l border-token-border bg-token-main-surface-primary">
            {detailRailContent}
          </div>
        </div>
      </aside>
    ) : null;

  return (
    <div
      data-testid="automations-route-shell"
      className="main-surface flex h-full min-h-0 w-full overflow-hidden text-token-text-primary"
    >
      {externalHeader ? <AppShellHeaderContentRegistrar content={routeHeader} /> : null}
      {detailRailContent && detailRailPortalTarget
        ? createPortal(detailRailContent, detailRailPortalTarget)
        : null}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {externalHeader ? <div aria-hidden="true" className="h-toolbar shrink-0" /> : routeHeader}
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <section
            data-testid="automations-main-column"
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {routeState.tab === "templates" ? (
              <AutomationsTemplatesPanel onSelectTemplate={selectTemplate} />
            ) : (
              <AutomationsTasksPanel
                automations={automations}
                runningAutomationIds={runningAutomationIds}
                unreadAutomationIds={unreadAutomationIds}
                selectedAutomationId={routeState.automationId}
                loading={automationsQuery.isLoading}
                runNowPendingAutomationId={runNowPendingAutomationId}
                mutatingAutomationId={mutatingAutomationId}
                onSelectAutomation={openAutomation}
                onRunAutomationNow={requestRunAutomationNow}
                onPauseAutomation={(automation) =>
                  requestUpdateAutomationStatus(automation, "PAUSED")
                }
                onResumeAutomation={(automation) =>
                  requestUpdateAutomationStatus(automation, "ACTIVE")
                }
                onDeleteAutomation={requestDeleteAutomationFromRow}
                onCreateManually={openCreateMode}
                onCreateWithChat={onCreateWithChat ? requestCreateWithChat : undefined}
              />
            )}
          </section>
          {inlineDetailRail}
        </div>
      </main>
      <NodexDialog
        open={deleteDialogAutomation !== null}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog();
        }}
      >
        <NodexDialogContent size="compact" showCloseButton={false}>
          <NodexDialogFrame>
            <NodexDialogHeader>
              <NodexDialogTitle>
                Delete <strong>{deleteDialogAutomation?.name || "New scheduled task"}</strong>?
              </NodexDialogTitle>
              <NodexDialogDescription>
                This will permanently delete the scheduled task and stop future runs.
              </NodexDialogDescription>
            </NodexDialogHeader>
            <NodexDialogFooter>
              <NodexDialogAction
                disabled={mutatingAutomationId !== null}
                onClick={closeDeleteDialog}
              >
                Cancel
              </NodexDialogAction>
              <NodexDialogAction
                tone="danger"
                disabled={mutatingAutomationId !== null}
                onClick={() => void confirmDeleteDialog()}
              >
                {deleteDialogAutomation && mutatingAutomationId === deleteDialogAutomation.id ? (
                  <AutomationLoadingIcon className="icon-xs" />
                ) : null}
                Delete scheduled task
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
      <NodexDialog
        open={dispageDraftDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDispageDraftDialog();
        }}
      >
        <NodexDialogContent size="compact" showCloseButton={false}>
          <NodexDialogFrame>
            <NodexDialogHeader>
              <NodexDialogTitle>Discard scheduled task draft?</NodexDialogTitle>
              <NodexDialogDescription>
                Your changes to this scheduled task will be lost
              </NodexDialogDescription>
            </NodexDialogHeader>
            <NodexDialogFooter>
              <NodexDialogAction onClick={closeDispageDraftDialog}>Keep editing</NodexDialogAction>
              <NodexDialogAction tone="danger" onClick={discardCreateDraft}>
                Discard
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </div>
  );
}
