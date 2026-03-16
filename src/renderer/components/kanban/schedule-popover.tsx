import { useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Card, RecurrenceFrequency } from "@/lib/types";
import type { ScheduleState } from "@/lib/use-schedule-state";
import {
  REPEAT_FREQUENCIES,
  REMINDER_PRESET_OFFSETS,
  WEEKDAY_OPTIONS,
  normalizeReminderOffsets,
  formatReminderOffset,
  formatRecurrenceSummary,
  formatRemindersSummary,
} from "@/lib/use-schedule-state";

// ── Icons ────────────────────────────────────────────────────────────────────

function ClockIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" className="shrink-0">
      <path d="M8.4 2.1a6.3 6.3 0 1 1 0 12.6 6.3 6.3 0 0 1 0-12.6Zm0 1.575a4.725 4.725 0 1 0 0 9.45 4.725 4.725 0 0 0 0-9.45Zm.788.787v3.443l2.55 1.53-.81 1.352-3.315-1.99V4.462h1.575Z" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={cn("shrink-0 transition-transform duration-150", className)}>
      <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
      <path d="M10.5 4.667H2.333v2.333M3.5 9.333h8.167V7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.75 2.917l1.75 1.75-1.75 1.75M5.25 11.083l-1.75-1.75 1.75-1.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
      <path d="M7 12.25c.644 0 1.167-.523 1.167-1.167H5.833c0 .644.523 1.167 1.167 1.167Zm3.5-3.5V5.833a3.483 3.483 0 0 0-2.917-3.441V1.75a.583.583 0 1 0-1.166 0v.642A3.483 3.483 0 0 0 3.5 5.833v2.917L2.333 9.917v.583h9.334v-.583L10.5 8.75Z" fill="currentColor" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.75 7h10.5M7 1.75c-1.5 1.5-2 3.25-2 5.25s.5 3.75 2 5.25c1.5-1.5 2-3.25 2-5.25s-.5-3.75-2-5.25Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

interface SchedulePopoverProps {
  schedule: ScheduleState;
  card: Card;
}

export function SchedulePopover({ schedule, card }: SchedulePopoverProps) {
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
        <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
          <PopoverPrimitive.Trigger asChild>
            <button
              className={cn(
                "flex flex-wrap items-center gap-1 rounded-sm px-0.5 py-0.5 transition-colors",
                "hover:bg-(--background-tertiary)",
                !hasSchedule && "text-(--foreground-tertiary) hover:text-(--foreground-secondary)",
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
                <span className="text-sm/5">Empty</span>
              )}
            </button>
          </PopoverPrimitive.Trigger>

          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              align="start"
              side="bottom"
              sideOffset={4}
              className={cn(
                "z-50 w-80 rounded-lg border shadow-lg",
                "border-(--border) bg-(--popover)",
                "animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2",
                "outline-none",
              )}
              onOpenAutoFocus={(e) => e.preventDefault()}
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
                        ? "bg-(--blue-bg) text-(--blue-text)"
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
                    <span className="text-sm font-medium text-(--foreground-secondary)">
                      Repeat
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-(--foreground-tertiary)">
                      {recurrenceSummary}
                    </span>
                    <ChevronIcon className={cn(repeatOpen && "rotate-180")} />
                  </div>
                </button>

                {repeatOpen && (
                  <div className="space-y-2 px-3 pb-3">
                    <Select
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
                    >
                      <SelectTrigger className="h-7 text-base">
                        <span>
                          {schedule.recurrenceEnabled
                            ? REPEAT_FREQUENCIES.find((f) => f === schedule.recurrenceFrequency) ?? "No repeat"
                            : "No repeat"}
                        </span>
                      </SelectTrigger>
                      <SelectContent sideOffset={4}>
                        <SelectItem value="none">No repeat</SelectItem>
                        {REPEAT_FREQUENCIES.map((freq) => (
                          <SelectItem key={freq} value={freq}>
                            {freq.charAt(0).toUpperCase() + freq.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

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
                                      : [...schedule.recurrenceWeekdays, day.value].sort((a, b) => a - b);
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
                                      ? "bg-(--accent-blue) text-white"
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
                          <Select
                            value={schedule.recurrenceEndType}
                            onValueChange={(value) => {
                              const nextType = value === "untilDate" ? "untilDate" as const : "never" as const;
                              schedule.setRecurrenceEndType(nextType);
                              const nextRecurrence = schedule.buildRecurrenceConfig({ endType: nextType });
                              if (nextRecurrence) {
                                schedule.saveProperty({ recurrence: nextRecurrence });
                              }
                            }}
                          >
                            <SelectTrigger className="h-7 text-sm">
                              <span>{schedule.recurrenceEndType === "untilDate" ? "Ends on date" : "Never ends"}</span>
                            </SelectTrigger>
                            <SelectContent sideOffset={4}>
                              <SelectItem value="never">Never ends</SelectItem>
                              <SelectItem value="untilDate">Ends on date</SelectItem>
                            </SelectContent>
                          </Select>
                          {schedule.recurrenceEndType === "untilDate" && (
                            <Input
                              type="date"
                              value={schedule.recurrenceUntilDate}
                              onChange={(e) => schedule.setRecurrenceUntilDate(e.target.value)}
                              onBlur={() => {
                                const nextRecurrence = schedule.buildRecurrenceConfig();
                                if (nextRecurrence) schedule.saveProperty({ recurrence: nextRecurrence });
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
                    <span className="text-xs text-(--foreground-tertiary)">
                      {remindersSummary}
                    </span>
                    <ChevronIcon className={cn(remindersOpen && "rotate-180")} />
                  </div>
                </button>

                {remindersOpen && (
                  <div className="space-y-2 px-3 pb-3">
                    <div className="flex flex-wrap gap-1">
                      {REMINDER_PRESET_OFFSETS.map((offset) => {
                        const selected = normalizeReminderOffsets(schedule.reminderOffsets).includes(offset);
                        return (
                          <button
                            key={offset}
                            type="button"
                            onClick={() => schedule.toggleReminderPreset(offset)}
                            className={cn(
                              "h-6 rounded-sm px-2 text-xs font-medium",
                              selected
                                ? "bg-(--accent-blue) text-white"
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
              <div className={cn(card.scheduledStart && "border-b border-(--border)")}>
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
                    <ChevronIcon className={cn(timezoneOpen && "rotate-180")} />
                  </div>
                </button>

                {timezoneOpen && (
                  <div className="px-3 pb-3">
                    <Input
                      value={schedule.scheduleTimezone}
                      onChange={(e) => schedule.setScheduleTimezone(e.target.value)}
                      onBlur={() => {
                        const trimmed = schedule.scheduleTimezone.trim();
                        schedule.saveProperty({ scheduleTimezone: trimmed.length > 0 ? trimmed : null });
                      }}
                      className="h-7 text-sm"
                      placeholder="e.g. America/New_York"
                    />
                  </div>
                )}
              </div>

              {/* Section 5: Occurrence actions */}
              {card.scheduledStart && (
                <div className="flex items-center gap-2 p-3">
                  {schedule.handleCompleteThisOccurrence && (
                    <button
                      type="button"
                      disabled={schedule.occurrenceBusy}
                      onClick={() => void schedule.handleCompleteThisOccurrence()}
                      className="h-7 rounded-sm bg-(--accent-blue) px-3 text-sm font-medium text-white transition-opacity disabled:opacity-50"
                    >
                      Mark done
                    </button>
                  )}
                  {card.recurrence && schedule.handleSkipThisOccurrence && (
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
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      </div>
    </div>
  );
}
