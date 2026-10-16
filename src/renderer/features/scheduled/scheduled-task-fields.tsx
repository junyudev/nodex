import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import {
  AutomationLoadingIcon,
  AutomationTemplateColorIcon,
  CompactChevronDownIcon,
  SidePanelPlusIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
  NodexDropdownTitle,
  NodexOptionPicker,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useLocalEnvironmentOptions } from "@/lib/use-local-environment-queries";
import type { Project, WorktreeEnvironmentOption } from "@/lib/types";
import {
  buildWorkbenchAutomationScheduleRrule,
  formatWorkbenchAutomationScheduleModeLabel,
  formatWorkbenchAutomationScheduleTimeLabel,
  resolveWorkbenchAutomationScheduleConfig,
  updateWorkbenchAutomationScheduleConfig,
  WORKBENCH_AUTOMATION_ALL_WEEKDAYS,
  WORKBENCH_AUTOMATION_WEEKDAY_LABELS,
  type WorkbenchAutomationScheduleConfig,
  type WorkbenchAutomationScheduleIntervalStyle,
  type WorkbenchAutomationScheduleMode,
  type WorkbenchAutomationWeekdayCode,
} from "@/components/workbench/workbench-automation-schedule";
import {
  buildWorkbenchAutomationProjectOptions,
  formatWorkbenchAutomationProjectTriggerLabel,
  resolveWorkbenchAutomationProjectForRoot,
  selectWorkbenchAutomationProjectRoot,
} from "@/components/workbench/workbench-automation-project-options";

/** The trailing control of a settings row: the current value and a chevron. */
export const SCHEDULED_FIELD_TRIGGER_CLASS =
  "no-drag inline-flex h-10 min-w-0 max-w-full cursor-interaction items-center gap-1.5 rounded-xl px-2.5 text-base text-token-text-secondary outline-hidden hover:text-token-foreground hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-token-focus-border data-[state=open]:bg-token-foreground/5 disabled:cursor-not-allowed disabled:opacity-40";

export function ScheduledFieldRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 ps-4 pe-1">
      <span className="shrink-0 text-base text-token-foreground">{label}</span>
      <div className="flex min-w-0 items-center justify-end">{children}</div>
    </div>
  );
}

/** Menu triggers receive the menu's props and ref, so this forwards both to its button. */
export const ScheduledFieldTrigger = forwardRef<
  HTMLButtonElement,
  Omit<ComponentPropsWithoutRef<"button">, "aria-label"> & {
    ariaLabel: string;
    pending?: boolean;
  }
>(function ScheduledFieldTrigger({ ariaLabel, pending = false, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      aria-label={ariaLabel}
      className={SCHEDULED_FIELD_TRIGGER_CLASS}
    >
      <span className="min-w-0 truncate">{children}</span>
      {pending ? (
        <AutomationLoadingIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
      ) : (
        <CompactChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
      )}
    </button>
  );
});

function ScheduledPickerField({
  label,
  value,
  options,
  disabled,
  searchable = false,
  display,
  onValueChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  disabled: boolean;
  searchable?: boolean;
  display?: ReactNode;
  onValueChange: (value: string) => void;
}) {
  return (
    <ScheduledFieldRow label={label}>
      <NodexOptionPicker
        value={value}
        options={options}
        onValueChange={onValueChange}
        title={label}
        align="end"
        side="bottom"
        contentWidth="sm"
        contentMaxHeight="list"
        search={searchable ? "filter" : "none"}
        searchAriaLabel={`Search ${label.toLocaleLowerCase()}`}
        disabled={disabled}
        triggerButton={
          <ScheduledFieldTrigger ariaLabel={label} disabled={disabled}>
            {display ?? options.find((option) => option.value === value)?.label ?? value}
          </ScheduledFieldTrigger>
        }
      />
    </ScheduledFieldRow>
  );
}

const SCHEDULE_MODES: readonly WorkbenchAutomationScheduleMode[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "custom",
];
const SCHEDULE_TIMES = Array.from({ length: 96 }, (_, index) => {
  const minutes = index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});
const CRON_INTERVAL_MINUTES = [60, 120, 180, 240, 360, 480, 720];
const HEARTBEAT_INTERVAL_MINUTES = [5, 10, 15, 30, 60, 120, 240, 480, 720, 1_440];

function localTimeZoneName(): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "longGeneric" })
    .formatToParts(new Date())
    .find((entry) => entry.type === "timeZoneName");
  return part?.value ?? "";
}

function formatIntervalAmount(minutes: number): string {
  const [amount, unit] =
    minutes % 1_440 === 0
      ? [minutes / 1_440, "day"]
      : minutes % 60 === 0
        ? [minutes / 60, "hour"]
        : [minutes, "minute"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

function withCurrentOption(values: readonly number[], current: number): number[] {
  return values.includes(current) ? [...values] : [...values, current].toSorted((a, b) => a - b);
}

/**
 * Repeat, its day, time, or interval, and a custom rule: the rows of the schedule card. A schedule
 * switched to Custom stays Custom even when its rule happens to read as a simpler mode.
 */
export function ScheduledScheduleFields({
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
  const [customRrule, setCustomRrule] = useState<string | null>(null);
  const parsed = resolveWorkbenchAutomationScheduleConfig({ rrule, intervalStyle });
  const config: WorkbenchAutomationScheduleConfig =
    customRrule !== null && customRrule === rrule
      ? { ...parsed, mode: "custom", customRrule: rrule }
      : parsed;
  const update = (patch: Partial<WorkbenchAutomationScheduleConfig>) => {
    const next = updateWorkbenchAutomationScheduleConfig({ config, patch, intervalStyle });
    const nextRrule = buildWorkbenchAutomationScheduleRrule({ config: next, intervalStyle });
    setCustomRrule(next.mode === "custom" ? nextRrule : null);
    onRruleChange(nextRrule);
  };
  const intervalMinutes =
    intervalStyle === "heartbeat"
      ? (config.intervalMinutes ?? 30)
      : Math.max(1, config.intervalHours) * 60;
  const intervalChoices = withCurrentOption(
    intervalStyle === "heartbeat" ? HEARTBEAT_INTERVAL_MINUTES : CRON_INTERVAL_MINUTES,
    intervalMinutes,
  );
  const hasTime = config.mode === "daily" || config.mode === "weekdays" || config.mode === "weekly";
  const timeZone = localTimeZoneName();

  return (
    <>
      <ScheduledPickerField
        label="Repeat"
        value={config.mode}
        disabled={disabled}
        options={SCHEDULE_MODES.map((mode) => ({
          value: mode,
          label: formatWorkbenchAutomationScheduleModeLabel(mode),
        }))}
        onValueChange={(mode) => update({ mode: mode as WorkbenchAutomationScheduleMode })}
      />
      {config.mode === "hourly" ? (
        <ScheduledPickerField
          label="Every"
          value={String(intervalMinutes)}
          disabled={disabled}
          options={intervalChoices.map((minutes) => ({
            value: String(minutes),
            label: formatIntervalAmount(minutes),
          }))}
          onValueChange={(value) => {
            const minutes = Number.parseInt(value, 10);
            update(
              intervalStyle === "heartbeat"
                ? { intervalMinutes: minutes }
                : { intervalHours: Math.max(1, Math.round(minutes / 60)) },
            );
          }}
        />
      ) : null}
      {config.mode === "weekly" ? (
        <ScheduledPickerField
          label="On"
          value={config.weekdays[0] ?? "MO"}
          disabled={disabled}
          options={WORKBENCH_AUTOMATION_ALL_WEEKDAYS.map((weekday) => ({
            value: weekday,
            label: WORKBENCH_AUTOMATION_WEEKDAY_LABELS[weekday],
          }))}
          onValueChange={(weekday) =>
            update({ weekdays: [weekday as WorkbenchAutomationWeekdayCode] })
          }
        />
      ) : null}
      {hasTime ? (
        <ScheduledPickerField
          label="Time"
          value={config.time}
          disabled={disabled}
          searchable
          options={(SCHEDULE_TIMES.includes(config.time)
            ? SCHEDULE_TIMES
            : [...SCHEDULE_TIMES, config.time].toSorted()
          ).map((time) => ({
            value: time,
            label: formatWorkbenchAutomationScheduleTimeLabel(time),
          }))}
          display={[formatWorkbenchAutomationScheduleTimeLabel(config.time), timeZone]
            .filter(Boolean)
            .join(" ")}
          onValueChange={(time) => update({ time })}
        />
      ) : null}
      {config.mode === "custom" ? (
        <div className="px-4 pb-3">
          <input
            aria-label="Custom rule"
            value={config.customRrule}
            disabled={disabled}
            spellCheck={false}
            placeholder="FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0"
            className="h-9 w-full rounded-xl bg-token-foreground/5 px-3 font-mono text-xs text-token-foreground outline-none placeholder:text-token-text-tertiary focus-visible:ring-2 focus-visible:ring-token-focus-border"
            onChange={(event) => update({ customRrule: event.currentTarget.value })}
          />
        </div>
      ) : null}
    </>
  );
}

export function ScheduledProjectField({
  projects,
  selectedRoots,
  selectedProjectId,
  disabled,
  onSelectionChange,
}: {
  projects: readonly Project[];
  selectedRoots: readonly string[];
  selectedProjectId: string | null;
  disabled: boolean;
  onSelectionChange: (selection: { projectId: string | null; cwds: string[] }) => void;
}) {
  const options = buildWorkbenchAutomationProjectOptions({
    projects,
    selectedRoots,
    selectedProjectId,
  });
  const selectedRootSet = new Set(selectedRoots);
  return (
    <ScheduledFieldRow label="Project">
      <NodexDropdownMenu
        align="end"
        side="bottom"
        contentWidth="workspace"
        contentMaxHeight="tall"
        disabled={disabled}
        triggerButton={
          <ScheduledFieldTrigger ariaLabel="Project" disabled={disabled}>
            {formatWorkbenchAutomationProjectTriggerLabel({
              selectedRoots,
              selectedProjectId,
              options,
            })}
          </ScheduledFieldTrigger>
        }
      >
        <NodexDropdownTitle>Project</NodexDropdownTitle>
        <NodexDropdownItem
          rightSlot={
            selectedProjectId === null && selectedRoots.length === 0 ? (
              <NodexDropdownSelectedIcon />
            ) : null
          }
          onSelect={() => onSelectionChange({ projectId: null, cwds: [] })}
        >
          No project
        </NodexDropdownItem>
        {options.length === 0 ? (
          <NodexDropdownMessage compact>No project folders available</NodexDropdownMessage>
        ) : (
          options.map((option) => (
            <NodexDropdownItem
              key={JSON.stringify([option.projectId, option.value])}
              disabled={option.isFallback || option.projectId === null}
              subText={option.description}
              rightSlot={
                selectedProjectId === option.projectId && selectedRootSet.has(option.value) ? (
                  <NodexDropdownSelectedIcon />
                ) : null
              }
              tooltipText={
                option.isFallback
                  ? "This saved folder is not in the current project list."
                  : undefined
              }
              onSelect={(event) => {
                event.preventDefault();
                if (!option.projectId) return;
                onSelectionChange(
                  selectWorkbenchAutomationProjectRoot({
                    selectedProjectId,
                    selectedRoots,
                    projectId: option.projectId,
                    root: option.value,
                  }),
                );
              }}
            >
              {option.label}
            </NodexDropdownItem>
          ))
        )}
      </NodexDropdownMenu>
    </ScheduledFieldRow>
  );
}

const DEFAULT_LOCAL_ENVIRONMENT_FILE_NAME = "environment.toml";

function environmentPathFileName(value: string): string {
  const parts = value.trim().split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? value.trim();
}

function environmentLabel(option: WorktreeEnvironmentOption): string {
  return option.name.trim() || environmentPathFileName(option.path);
}

/** A worktree task may start each run from one of its Project's local environments. */
export function ScheduledEnvironmentField({
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
  const project = resolveWorkbenchAutomationProjectForRoot({
    projects,
    root: selectedRoot,
    projectId: projects[0]?.id ?? null,
  });
  const environmentsQuery = useLocalEnvironmentOptions(project?.id ?? "", {
    enabled: project !== null,
  });
  const environments = environmentsQuery.data ?? [];
  const selectedPath = selectedConfigPath.trim();
  const selected =
    environments.find((environment) => environment.path.trim() === selectedPath) ?? null;
  const preferred =
    environments.find(
      (environment) =>
        environmentPathFileName(environment.path) === DEFAULT_LOCAL_ENVIRONMENT_FILE_NAME,
    ) ??
    environments[0] ??
    null;
  const ordered = preferred
    ? [preferred, ...environments.filter((environment) => environment !== preferred)]
    : environments;
  const loading = project !== null && environmentsQuery.isLoading;

  return (
    <ScheduledFieldRow label="Environment">
      <NodexDropdownMenu
        align="end"
        side="bottom"
        contentClassName="w-64"
        disabled={disabled}
        triggerButton={
          <ScheduledFieldTrigger ariaLabel="Environment" disabled={disabled} pending={loading}>
            {loading ? "Loading…" : selected ? environmentLabel(selected) : "No environment"}
          </ScheduledFieldTrigger>
        }
      >
        <NodexDropdownTitle>Local environment</NodexDropdownTitle>
        <div className="vertical-scroll-fade-mask flex max-h-[220px] flex-col overflow-y-auto">
          {environmentsQuery.isError ? (
            <NodexDropdownMessage compact tone="error">
              Error loading environments
            </NodexDropdownMessage>
          ) : loading ? null : (
            <>
              <NodexDropdownItem
                rightSlot={selectedPath.length === 0 ? <NodexDropdownSelectedIcon /> : null}
                onSelect={() => onSelectedConfigPathChange("")}
              >
                No environment
              </NodexDropdownItem>
              {ordered.map((environment) => (
                <NodexDropdownItem
                  key={environment.path}
                  leftSlot={
                    environment === preferred ? (
                      <NodexTooltip tooltipContent="Default environment">
                        <span>
                          <AutomationTemplateColorIcon
                            iconName="star-app"
                            className="icon-xxs shrink-0"
                          />
                        </span>
                      </NodexTooltip>
                    ) : null
                  }
                  rightSlot={
                    selectedPath.length > 0 && environment.path.trim() === selectedPath ? (
                      <NodexDropdownSelectedIcon />
                    ) : null
                  }
                  onSelect={() => onSelectedConfigPathChange(environment.path)}
                >
                  {environmentLabel(environment)}
                </NodexDropdownItem>
              ))}
            </>
          )}
        </div>
        <NodexDropdownSeparator />
        <NodexDropdownItem
          leftSlot={<SidePanelPlusIcon className="icon-2xs shrink-0" />}
          onSelect={() =>
            onOpenSettings?.({
              projectId: project?.id ?? null,
              configPath: selectedPath.length > 0 ? selectedPath : null,
            })
          }
        >
          Create local environment
        </NodexDropdownItem>
      </NodexDropdownMenu>
    </ScheduledFieldRow>
  );
}

/** A Chat a Heartbeat can run in. */
export interface ScheduledTaskChatOption {
  readonly id: string;
  readonly title: string;
  readonly projectName: string | null;
}

export function ScheduledChatField({
  chats,
  selectedChatId,
  disabled,
  onSelectedChatIdChange,
}: {
  chats: readonly ScheduledTaskChatOption[];
  selectedChatId: string;
  disabled: boolean;
  onSelectedChatIdChange: (chatId: string) => void;
}) {
  const options =
    chats.some((chat) => chat.id === selectedChatId) || !selectedChatId
      ? chats
      : [{ id: selectedChatId, title: "Selected chat", projectName: null }, ...chats];
  return (
    <ScheduledFieldRow label="Runs in">
      <NodexOptionPicker
        value={selectedChatId}
        title="Chat"
        align="end"
        side="bottom"
        contentWidth="menuWide"
        contentMaxHeight="tall"
        search="filter"
        searchAriaLabel="Search chats"
        searchPlaceholder="Search chats"
        emptyMessage="No chats yet"
        noResultsMessage="No matching chats"
        disabled={disabled}
        options={options.map((chat) => ({
          value: chat.id,
          label: chat.title,
          subText: chat.projectName ?? undefined,
          searchText: `${chat.title} ${chat.projectName ?? ""}`,
        }))}
        onValueChange={onSelectedChatIdChange}
        triggerButton={
          <ScheduledFieldTrigger ariaLabel="Chat" disabled={disabled}>
            {options.find((chat) => chat.id === selectedChatId)?.title ?? (
              <span className="text-token-text-tertiary">Select chat</span>
            )}
          </ScheduledFieldTrigger>
        }
      />
    </ScheduledFieldRow>
  );
}
