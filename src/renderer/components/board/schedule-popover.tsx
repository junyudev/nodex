import { useState } from "react";
import {
  BellIcon,
  ClockIcon,
  GlobeIcon,
  RepeatIcon,
  SmallChevronDownIcon,
} from "@/components/shared/icons";
import { NodexDropdownButtonTrigger, NodexOptionPicker } from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import {
  DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
  PropertyEmptyValue,
} from "@/components/database/property-empty-value";
import { cn } from "@/lib/utils";
import type { RecurrenceFrequency } from "@/lib/types";
import type { PageScheduleSource, ScheduleState } from "@/lib/use-schedule-state";
import {
  REPEAT_FREQUENCIES,
  REMINDER_PRESET_OFFSETS,
  WEEKDAY_OPTIONS,
  normalizeReminderOffsets,
  formatReminderOffset,
  formatRecurrenceSummary,
  formatRemindersSummary,
} from "@/lib/use-schedule-state";

interface SchedulePopoverProps {
  schedule: ScheduleState;
  page: Pick<PageScheduleSource, "scheduledStart" | "recurrence">;
}

export function SchedulePopover({ schedule, page }: SchedulePopoverProps) {
  const [open, setOpen] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [timezoneOpen, setTimezoneOpen] = useState(false);

  const hasSchedule = Boolean(schedule.scheduleSummary);
  const recurrenceSummary = formatRecurrenceSummary(
    schedule.recurrenceEnabled,
    schedule.recurrenceFrequency,
    schedule.recurrenceInterval,
  );
  const remindersSummary = formatRemindersSummary(schedule.reminderOffsets);

  return (
    <div className="flex min-h-7.5 items-center">
      <div className="flex w-40 shrink-0 items-center gap-1.5 pl-1.5">
        <div className="flex w-5 items-center justify-center text-(--foreground-secondary)">
          <ClockIcon />
        </div>
        <span className="text-sm/5 font-normal text-(--foreground-secondary)">Schedule</span>
      </div>
      <div className="flex-1 px-2">
        <NodexPopover open={open} onOpenChange={setOpen}>
          <NodexPopoverTrigger>
            <button
              type="button"
              className={cn(
                "flex flex-wrap items-center gap-1",
                DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
              )}
              aria-label={hasSchedule ? "Edit schedule" : "Set schedule"}
            >
              {schedule.scheduleSummary ? (
                <>
                  <span className="inline-flex h-5 items-center rounded-sm bg-(--gray-bg) px-1.5 text-xs text-(--foreground-secondary)">
                    {schedule.scheduleSummary.date}
                  </span>
                  <span className="inline-flex h-5 items-center rounded-sm bg-(--blue-bg) px-1.5 text-xs text-(--blue-text)">
                    {schedule.scheduleSummary.time}
                  </span>
                  <span className="inline-flex h-5 items-center rounded-sm bg-(--background-tertiary) px-1.5 text-xs text-(--foreground-secondary)">
                    {schedule.scheduleSummary.duration}
                  </span>
                  {schedule.recurrenceEnabled && (
                    <span className="inline-flex h-5 items-center rounded-sm bg-(--purple-bg,var(--gray-bg)) px-1.5 text-xs text-(--purple-text,var(--foreground-secondary))">
                      {recurrenceSummary}
                    </span>
                  )}
                </>
              ) : (
                <PropertyEmptyValue className="text-sm/5" />
              )}
            </button>
          </NodexPopoverTrigger>

          <NodexPopoverContent
            align="start"
            side="bottom"
            className="w-80 p-0"
            initialFocus={false}
          >
            {/* Section 1: Date & Time */}
            <div className="space-y-2.5 border-b border-(--border) p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium tracking-wide text-(--foreground-tertiary) uppercase">
                  Date & Time
                </span>
                <button
                  type="button"
                  aria-pressed={schedule.isAllDay}
                  onClick={schedule.handleToggleAllDay}
                  className={cn(
                    "h-6 rounded-sm px-2 text-xs font-medium transition-colors",
                    schedule.isAllDay
                      ? "bg-text-info/10 text-info"
                      : "bg-(--background-tertiary) text-(--foreground-secondary) hover:bg-(--gray-bg)",
                  )}
                >
                  All day
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-0.5">
                  <span className="text-xs font-medium tracking-wide text-(--foreground-tertiary) uppercase">
                    Start
                  </span>
                  <Input
                    type={schedule.isAllDay ? "date" : "datetime-local"}
                    value={schedule.scheduledStart}
                    onChange={(e) => schedule.handleScheduledStartChange(e.target.value)}
                    className="h-8 text-base"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-xs font-medium tracking-wide text-(--foreground-tertiary) uppercase">
                    {schedule.isAllDay ? "End (incl.)" : "End"}
                  </span>
                  <Input
                    type={schedule.isAllDay ? "date" : "datetime-local"}
                    value={schedule.scheduledEnd}
                    min={schedule.scheduledStart || undefined}
                    onChange={(e) => schedule.handleScheduledEndChange(e.target.value)}
                    className="h-8 text-base"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={schedule.handleSetDefaultSchedule}
                  className="h-6 rounded-sm bg-(--background-tertiary) px-2 text-xs font-medium text-(--foreground-secondary) transition-colors hover:bg-(--gray-bg)"
                >
                  {schedule.isAllDay ? "Today" : "Now + 1h"}
                </button>
                {(schedule.scheduledStart || schedule.scheduledEnd) && (
                  <button
                    type="button"
                    onClick={schedule.handleClearSchedule}
                    className="h-6 rounded-sm bg-(--red-bg) px-2 text-xs font-medium text-(--red-text) hover:opacity-90"
                  >
                    Clear
                  </button>
                )}
              </div>

              {schedule.scheduleHint && (
                <p className="text-xs text-(--foreground-tertiary)">{schedule.scheduleHint}</p>
              )}
            </div>

            {/* Section 2: Repeat */}
            <div className="border-b border-(--border)">
              <button
                type="button"
                onClick={() => setRepeatOpen((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 transition-colors hover:bg-(--background-tertiary)"
                aria-expanded={repeatOpen}
              >
                <div className="flex items-center gap-1.5">
                  <RepeatIcon />
                  <span className="text-sm font-medium text-(--foreground-secondary)">Repeat</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-(--foreground-tertiary)">{recurrenceSummary}</span>
                  <SmallChevronDownIcon
                    className={cn("transition-transform duration-150", repeatOpen && "rotate-180")}
                  />
                </div>
              </button>

              {repeatOpen && (
                <div className="space-y-2 px-3 pb-3">
                  <NodexOptionPicker
                    value={schedule.recurrenceEnabled ? schedule.recurrenceFrequency : "none"}
                    onValueChange={(value) => {
                      if (value === "none") {
                        schedule.setRecurrenceEnabled(false);
                        schedule.saveProperty({ recurrence: null });
                        return;
                      }
                      if (!REPEAT_FREQUENCIES.includes(value as RecurrenceFrequency)) return;
                      schedule.setRecurrenceEnabled(true);
                      schedule.setRecurrenceFrequency(value as RecurrenceFrequency);
                      const nextRecurrence = schedule.buildRecurrenceConfig({
                        enabled: true,
                        frequency: value as RecurrenceFrequency,
                      });
                      if (nextRecurrence) {
                        schedule.setRecurrenceInterval(String(nextRecurrence.interval));
                        schedule.saveProperty({ recurrence: nextRecurrence });
                      }
                    }}
                    options={[
                      { value: "none", label: "No repeat" },
                      ...REPEAT_FREQUENCIES.map((freq) => ({
                        value: freq,
                        label: freq.charAt(0).toUpperCase() + freq.slice(1),
                      })),
                    ]}
                    triggerButton={
                      <NodexDropdownButtonTrigger className="h-7 text-base">
                        <span>
                          {schedule.recurrenceEnabled
                            ? (REPEAT_FREQUENCIES.find((f) => f === schedule.recurrenceFrequency) ??
                              "No repeat")
                            : "No repeat"}
                        </span>
                      </NodexDropdownButtonTrigger>
                    }
                  />

                  {schedule.recurrenceEnabled && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-(--foreground-secondary)">Every</span>
                        <Input
                          type="number"
                          min={1}
                          value={schedule.recurrenceInterval}
                          onChange={(e) => schedule.setRecurrenceInterval(e.target.value)}
                          onBlur={() => {
                            const nextRecurrence = schedule.buildRecurrenceConfig();
                            if (!nextRecurrence) return;
                            schedule.setRecurrenceInterval(String(nextRecurrence.interval));
                            schedule.saveProperty({ recurrence: nextRecurrence });
                          }}
                          className="h-7 w-16 text-base"
                        />
                        <span className="text-sm text-(--foreground-secondary)">
                          {schedule.recurrenceFrequency}
                        </span>
                      </div>

                      {schedule.recurrenceFrequency === "weekly" && (
                        <div className="flex flex-wrap gap-1">
                          {WEEKDAY_OPTIONS.map((day) => {
                            const selected = schedule.recurrenceWeekdays.includes(day.value);
                            return (
                              <button
                                key={day.value}
                                type="button"
                                onClick={() => {
                                  const nextWeekdays = selected
                                    ? schedule.recurrenceWeekdays.filter((v) => v !== day.value)
                                    : [...schedule.recurrenceWeekdays, day.value].sort(
                                        (a, b) => a - b,
                                      );
                                  schedule.setRecurrenceWeekdays(nextWeekdays);
                                  const nextRecurrence = schedule.buildRecurrenceConfig({
                                    byWeekdays: nextWeekdays,
                                  });
                                  if (nextRecurrence) {
                                    schedule.saveProperty({ recurrence: nextRecurrence });
                                  }
                                }}
                                className={cn(
                                  "h-6 rounded-sm px-2 text-xs font-medium",
                                  selected
                                    ? "bg-chart-blue text-(--app-color-text-on-accent)"
                                    : "bg-(--gray-bg) text-(--foreground-secondary)",
                                )}
                              >
                                {day.label}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <NodexOptionPicker
                          value={schedule.recurrenceEndType}
                          onValueChange={(value) => {
                            const nextType =
                              value === "untilDate" ? ("untilDate" as const) : ("never" as const);
                            schedule.setRecurrenceEndType(nextType);
                            const nextRecurrence = schedule.buildRecurrenceConfig({
                              endType: nextType,
                            });
                            if (nextRecurrence) {
                              schedule.saveProperty({ recurrence: nextRecurrence });
                            }
                          }}
                          options={[
                            { value: "never", label: "Never ends" },
                            { value: "untilDate", label: "Ends on date" },
                          ]}
                          triggerButton={
                            <NodexDropdownButtonTrigger className="h-7 text-sm">
                              <span>
                                {schedule.recurrenceEndType === "untilDate"
                                  ? "Ends on date"
                                  : "Never ends"}
                              </span>
                            </NodexDropdownButtonTrigger>
                          }
                        />
                        {schedule.recurrenceEndType === "untilDate" && (
                          <Input
                            type="date"
                            value={schedule.recurrenceUntilDate}
                            onChange={(e) => schedule.setRecurrenceUntilDate(e.target.value)}
                            onBlur={() => {
                              const nextRecurrence = schedule.buildRecurrenceConfig();
                              if (nextRecurrence)
                                schedule.saveProperty({ recurrence: nextRecurrence });
                            }}
                            className="h-7 w-35 text-sm"
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Section 3: Reminders */}
            <div className="border-b border-(--border)">
              <button
                type="button"
                onClick={() => setRemindersOpen((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 transition-colors hover:bg-(--background-tertiary)"
                aria-expanded={remindersOpen}
              >
                <div className="flex items-center gap-1.5">
                  <BellIcon />
                  <span className="text-sm font-medium text-(--foreground-secondary)">
                    Reminders
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-(--foreground-tertiary)">{remindersSummary}</span>
                  <SmallChevronDownIcon
                    className={cn(
                      "transition-transform duration-150",
                      remindersOpen && "rotate-180",
                    )}
                  />
                </div>
              </button>

              {remindersOpen && (
                <div className="space-y-2 px-3 pb-3">
                  <div className="flex flex-wrap gap-1">
                    {REMINDER_PRESET_OFFSETS.map((offset) => {
                      const selected = normalizeReminderOffsets(schedule.reminderOffsets).includes(
                        offset,
                      );
                      return (
                        <button
                          key={offset}
                          type="button"
                          onClick={() => schedule.toggleReminderPreset(offset)}
                          className={cn(
                            "h-6 rounded-sm px-2 text-xs font-medium",
                            selected
                              ? "bg-chart-blue text-(--app-color-text-on-accent)"
                              : "bg-(--gray-bg) text-(--foreground-secondary)",
                          )}
                        >
                          {formatReminderOffset(offset)}
                        </button>
                      );
                    })}
                  </div>
                  <Input
                    value={schedule.reminderOffsets}
                    onChange={(e) => schedule.setReminderOffsets(e.target.value)}
                    onBlur={() => schedule.persistReminderOffsets(schedule.reminderOffsets)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      schedule.persistReminderOffsets(schedule.reminderOffsets);
                    }}
                    className="h-7 text-sm"
                    placeholder="Minutes before (e.g. 10, 60, 1440)"
                  />
                </div>
              )}
            </div>

            {/* Section 4: Timezone */}
            <div className={cn(page.scheduledStart && "border-b border-(--border)")}>
              <button
                type="button"
                onClick={() => setTimezoneOpen((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 transition-colors hover:bg-(--background-tertiary)"
                aria-expanded={timezoneOpen}
              >
                <div className="flex items-center gap-1.5">
                  <GlobeIcon />
                  <span className="text-sm font-medium text-(--foreground-secondary)">
                    Timezone
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="max-w-30 truncate text-xs text-(--foreground-tertiary)">
                    {schedule.scheduleTimezone || "Local"}
                  </span>
                  <SmallChevronDownIcon
                    className={cn(
                      "transition-transform duration-150",
                      timezoneOpen && "rotate-180",
                    )}
                  />
                </div>
              </button>

              {timezoneOpen && (
                <div className="px-3 pb-3">
                  <Input
                    value={schedule.scheduleTimezone}
                    onChange={(e) => schedule.setScheduleTimezone(e.target.value)}
                    onBlur={() => {
                      const trimmed = schedule.scheduleTimezone.trim();
                      schedule.saveProperty({
                        scheduleTimezone: trimmed.length > 0 ? trimmed : null,
                      });
                    }}
                    className="h-7 text-sm"
                    placeholder="e.g. America/New_York"
                  />
                </div>
              )}
            </div>

            {/* Section 5: Occurrence actions */}
            {page.scheduledStart && (
              <div className="flex items-center gap-2 p-3">
                {schedule.handleCompleteThisOccurrence && (
                  <button
                    type="button"
                    disabled={schedule.occurrenceBusy}
                    onClick={() => void schedule.handleCompleteThisOccurrence()}
                    className="h-7 rounded-sm bg-primary-solid px-3 text-sm font-medium text-primary-solid transition-opacity disabled:opacity-50"
                  >
                    Mark done
                  </button>
                )}
                {page.recurrence && schedule.handleSkipThisOccurrence && (
                  <button
                    type="button"
                    disabled={schedule.occurrenceBusy}
                    onClick={() => void schedule.handleSkipThisOccurrence()}
                    className="h-7 rounded-sm bg-(--gray-bg) px-3 text-sm font-medium text-(--foreground-secondary) transition-opacity disabled:opacity-50"
                  >
                    Skip
                  </button>
                )}
              </div>
            )}
          </NodexPopoverContent>
        </NodexPopover>
      </div>
    </div>
  );
}
