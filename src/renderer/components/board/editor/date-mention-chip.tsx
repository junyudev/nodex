import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DateRange } from "react-day-picker";
import {
  NodexOptionPicker,
  NodexDropdownSeparator,
  type NodexOptionPickerOption,
} from "@/components/ui/dropdown";
import {
  NodexPopover,
  NodexPopoverAnchor,
  NodexPopoverContent,
  NodexPopoverTitle,
} from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  BellIcon,
  CalendarIcon,
  CheckmarkIcon,
  ClockIcon,
  SmallChevronDownIcon,
} from "@/components/shared/icons";
import { NodexDateCalendarHeader } from "@/components/ui/date-calendar-header";
import {
  addIsoDateDays,
  createDateMentionPayload,
  createDateMentionDateTimeValue,
  currentIsoTime,
  dateMentionValueToIsoDate,
  dateMentionValueToTime,
  dateMentionValueToUtcOffset,
  dateToIsoDate,
  formatDateMentionPlainText,
  getDateFormatLabel,
  getLocalDateMentionTimeZone,
  getReminderLabel,
  getTimeFormatLabel,
  isoDateToDate,
  isDateMentionDateTimeValue,
  DATE_MENTION_DATE_FORMATS,
  DATE_MENTION_REMINDER_PRESETS,
  DATE_MENTION_TIME_FORMATS,
  parseDateMentionInput,
  todayIsoDate,
} from "../../../../shared/rich-text/date-mention";
import type { DateMentionInlineContent } from "../../../../shared/rich-text/date-mention";
import { cn } from "@/lib/utils";
import { DateMentionInlineVisual } from "../date-mention-inline-visual";
import {
  buildDateMentionUpdate,
  dateMentionPayloadToProps,
  dateMentionPropsToPayload,
  normalizeDateMentionProps,
  type DateMentionInlineContentUpdate,
  type DateMentionPatch,
  type DateMentionProps,
} from "./date-mention-inline-content";

let dateMentionCalendarPromise: Promise<typeof import("./date-mention-calendar")> | undefined;

/** Warms the deferred calendar before an interaction that is likely to open it. */
export const preloadDateMentionCalendar = () => {
  dateMentionCalendarPromise ??= import("./date-mention-calendar");
  return dateMentionCalendarPromise;
};

const LazyDateMentionCalendar = lazy(async () => ({
  default: (await preloadDateMentionCalendar()).DateMentionCalendar,
}));

const DATE_FORMAT_OPTIONS: NodexOptionPickerOption[] = DATE_MENTION_DATE_FORMATS.map((format) => ({
  value: format,
  label: getDateFormatLabel(format),
  subText: format === "relative" ? "Today, Tomorrow, Jun 28 fallback" : format,
}));

const TIME_FORMAT_OPTIONS: NodexOptionPickerOption[] = [
  { value: "", label: getTimeFormatLabel(undefined), subText: "Use browser locale" },
  ...DATE_MENTION_TIME_FORMATS.map((format) => ({
    value: format,
    label: getTimeFormatLabel(format),
    subText: format === "12h" ? "2:30 PM" : "14:30",
  })),
];

const REMINDER_OPTIONS: NodexOptionPickerOption[] = [
  { value: "", label: "None" },
  ...DATE_MENTION_REMINDER_PRESETS.map((reminder) => ({
    value: reminder,
    label: getReminderLabel(reminder),
  })),
];

function DateMentionSwitch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "flex h-4 w-7 items-center rounded-full p-0.5 outline-hidden",
        "focus-visible:ring-token-focus-border focus-visible:ring-2",
        checked ? "bg-chart-blue" : "bg-text/10",
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      <span
        className={cn(
          "size-3 rounded-full border border-control-thumb-on-accent bg-control-thumb-on-accent shadow-sm",
          checked && "translate-x-3",
        )}
      />
    </button>
  );
}

function DateMentionControlRow({
  icon,
  label,
  value,
  action,
  disabled,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  value?: ReactNode;
  action?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const className = cn(
    "flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-hidden",
    "focus-visible:ring-token-focus-border focus-visible:ring-2",
    disabled
      ? "cursor-default text-token-description-foreground opacity-55"
      : "text-token-foreground",
    !disabled && !action && "cursor-interaction hover:bg-token-list-hover-background",
  );
  const children = (
    <>
      {icon ? (
        <span className="flex size-5 shrink-0 items-center justify-center text-token-description-foreground">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value ? (
        <span className="min-w-0 max-w-[8rem] truncate text-token-description-foreground">
          {value}
        </span>
      ) : null}
      {action}
    </>
  );
  const content = action ? (
    <div className={className}>{children}</div>
  ) : (
    <button type="button" disabled={disabled} className={className} onClick={onClick}>
      {children}
    </button>
  );

  if (!disabled) return content;

  return (
    <NodexTooltip
      tooltipContent={<span>Not wired to card scheduling yet.</span>}
      side="right"
      align="center"
      sideOffset={6}
    >
      {content}
    </NodexTooltip>
  );
}

function DateMentionPopoverBody({
  props,
  onPatch,
}: {
  props: DateMentionProps;
  onPatch: (patch: DateMentionPatch) => void;
}) {
  const payload = dateMentionPropsToPayload(props);
  const startDateValue = dateMentionValueToIsoDate(payload.start) ?? todayIsoDate();
  const endDateValue = payload.end ? dateMentionValueToIsoDate(payload.end) : null;
  const startTime = dateMentionValueToTime(payload.start);
  const endTime = payload.end ? dateMentionValueToTime(payload.end) : null;
  const startDate = useMemo(() => isoDateToDate(startDateValue) ?? new Date(), [startDateValue]);
  const selectedRange = payload.end
    ? { from: startDate, to: isoDateToDate(endDateValue ?? startDateValue) ?? startDate }
    : { from: startDate, to: undefined };
  const [month, setMonth] = useState(startDate);
  const [dateInput, setDateInput] = useState(startDateValue);
  const hasEndDate = Boolean(payload.end);
  const hasTime = isDateMentionDateTimeValue(payload.start);

  useEffect(() => {
    setDateInput(startDateValue);
    setMonth(startDate);
  }, [startDate, startDateValue]);

  const patchPayload = (nextPayload: DateMentionInlineContent) => {
    onPatch(dateMentionPayloadToProps(nextPayload));
  };

  const buildDateValue = (date: string, time = startTime ?? currentIsoTime()) => {
    if (!hasTime) return date;
    return createDateMentionDateTimeValue(
      date,
      time,
      payload.tz,
      dateMentionValueToUtcOffset(payload.start),
    );
  };

  const setSelectedDate = (date: Date | undefined) => {
    if (!date) return;
    const nextDate = dateToIsoDate(date);
    patchPayload(
      createDateMentionPayload(buildDateValue(nextDate), {
        tz: hasTime ? payload.tz : undefined,
        format: payload.format ?? "relative",
        timeFormat: payload.timeFormat,
        reminder: payload.reminder,
      }),
    );
  };

  const setSelectedRange = (range: DateRange | undefined) => {
    if (!range?.from) return;
    const nextStartDate = dateToIsoDate(range.from);
    const nextEndDate = dateToIsoDate(range.to ?? range.from);
    const nextStart = buildDateValue(nextStartDate);
    const nextEnd = hasTime
      ? createDateMentionDateTimeValue(
          nextEndDate,
          endTime ?? startTime ?? currentIsoTime(),
          payload.tz,
          dateMentionValueToUtcOffset(payload.end ?? payload.start),
        )
      : nextEndDate;
    patchPayload(
      createDateMentionPayload(nextStart, {
        end: nextEnd,
        tz: hasTime ? payload.tz : undefined,
        format: payload.format ?? "relative",
        timeFormat: payload.timeFormat,
        reminder: payload.reminder,
      }),
    );
  };

  const applyInputDate = () => {
    const parsed = parseDateMentionInput(dateInput);
    if (!parsed) {
      setDateInput(startDateValue);
      return;
    }
    setMonth(isoDateToDate(parsed) ?? month);
    onPatch({ start: buildDateValue(parsed) });
  };

  const toggleEndDate = (checked: boolean) => {
    const fallbackEndDate = addIsoDateDays(startDateValue, 1);
    const nextEnd = checked
      ? (payload.end ??
        (hasTime
          ? createDateMentionDateTimeValue(
              fallbackEndDate,
              endTime ?? startTime ?? currentIsoTime(),
              payload.tz,
              dateMentionValueToUtcOffset(payload.start),
            )
          : fallbackEndDate))
      : "";
    onPatch({
      end: nextEnd,
    });
  };

  const toggleTime = (checked: boolean) => {
    if (checked) {
      const localTimeZone = payload.tz || getLocalDateMentionTimeZone();
      const nextStartTime = startTime ?? currentIsoTime();
      const nextEndDate = endDateValue ?? addIsoDateDays(startDateValue, 1);
      const nextEndTime = endTime ?? nextStartTime;
      onPatch({
        start: createDateMentionDateTimeValue(startDateValue, nextStartTime, localTimeZone),
        end: hasEndDate
          ? createDateMentionDateTimeValue(nextEndDate, nextEndTime, localTimeZone)
          : "",
        tz: localTimeZone,
      });
      return;
    }

    onPatch({
      start: startDateValue,
      end: hasEndDate ? (endDateValue ?? startDateValue) : "",
      tz: "",
      timeFormat: "",
    });
  };

  const timezoneOptions = useMemo(() => {
    const local = getLocalDateMentionTimeZone();
    const current = payload.tz || local;
    const values = Array.from(
      new Set([current, local, "UTC", "America/Los_Angeles", "Europe/London", "Asia/Shanghai"]),
    );
    return values.map((value) => ({
      value,
      label: value === local ? `${value} (local)` : value,
    }));
  }, [payload.tz]);

  const setTimezone = (tz: string) => {
    if (!hasTime) {
      onPatch({ tz });
      return;
    }

    onPatch({
      start: createDateMentionDateTimeValue(startDateValue, startTime ?? currentIsoTime(), tz),
      end: hasEndDate
        ? createDateMentionDateTimeValue(
            endDateValue ?? startDateValue,
            endTime ?? startTime ?? currentIsoTime(),
            tz,
          )
        : "",
      tz,
    });
  };

  return (
    <div className="w-[280px] min-w-[180px] max-w-[calc(100vw-24px)] text-sm">
      <div className="px-2 pt-2">
        <NodexPopoverTitle className="sr-only">Date mention</NodexPopoverTitle>
        <div className="flex h-8 items-center gap-1 rounded-lg bg-token-foreground/5 px-2">
          <CalendarIcon className="icon-2xs shrink-0 text-token-description-foreground" />
          <input
            aria-label="Date"
            value={dateInput}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-token-foreground outline-hidden placeholder:text-token-description-foreground"
            placeholder="Enter date"
            onChange={(event) => setDateInput(event.currentTarget.value)}
            onBlur={applyInputDate}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyInputDate();
              }
            }}
          />
        </div>
      </div>

      <NodexDateCalendarHeader
        month={month}
        onMonthChange={setMonth}
        onToday={() => {
          const today = todayIsoDate();
          setMonth(isoDateToDate(today) ?? new Date());
          onPatch({ start: buildDateValue(today) });
        }}
      />

      <Suspense fallback={<div aria-hidden="true" className="h-48 w-full" />}>
        <LazyDateMentionCalendar
          hasEndDate={hasEndDate}
          selectedRange={selectedRange}
          selectedDate={startDate}
          month={month}
          onMonthChange={setMonth}
          onSelectDate={setSelectedDate}
          onSelectRange={setSelectedRange}
        />
      </Suspense>

      <NodexDropdownSeparator paddingClassName="py-1" />

      <div className="px-1 pb-1">
        <DateMentionControlRow
          icon={<CalendarIcon className="icon-2xs" />}
          label="End date"
          action={
            <DateMentionSwitch
              checked={hasEndDate}
              label="End date"
              onCheckedChange={toggleEndDate}
            />
          }
        />

        <NodexOptionPicker
          value={payload.format ?? "relative"}
          options={DATE_FORMAT_OPTIONS}
          onValueChange={(format) => onPatch({ format })}
          contentWidth="menu"
          triggerButton={
            <DateMentionControlRow
              icon={<SmallChevronDownIcon className="icon-2xs" />}
              label="Date format"
              value={getDateFormatLabel(payload.format)}
            />
          }
        />

        <DateMentionControlRow
          icon={<ClockIcon className="icon-2xs" />}
          label="Include time"
          value={hasTime ? (startTime ?? undefined) : undefined}
          action={
            <DateMentionSwitch
              checked={hasTime}
              label="Include time"
              onCheckedChange={toggleTime}
            />
          }
        />

        {hasTime ? (
          <>
            <NodexOptionPicker
              value={payload.timeFormat ?? ""}
              options={TIME_FORMAT_OPTIONS}
              onValueChange={(timeFormat) => onPatch({ timeFormat })}
              contentWidth="menu"
              triggerButton={
                <DateMentionControlRow
                  icon={<ClockIcon className="icon-2xs" />}
                  label="Time format"
                  value={getTimeFormatLabel(payload.timeFormat)}
                />
              }
            />

            <NodexOptionPicker
              value={payload.tz || getLocalDateMentionTimeZone()}
              options={timezoneOptions}
              search="filter"
              searchPlaceholder="Search timezones…"
              searchAriaLabel="Search timezones"
              onValueChange={setTimezone}
              contentWidth="workspace"
              triggerButton={
                <DateMentionControlRow
                  icon={<CalendarIcon className="icon-2xs" />}
                  label="Timezone"
                  value={payload.tz || getLocalDateMentionTimeZone()}
                />
              }
            />
          </>
        ) : null}

        <NodexOptionPicker
          value={payload.reminder ?? ""}
          options={
            payload.reminder && !DATE_MENTION_REMINDER_PRESETS.includes(payload.reminder as never)
              ? [
                  ...REMINDER_OPTIONS,
                  {
                    value: payload.reminder,
                    label: "Custom reminder",
                    subText: payload.reminder,
                    disabled: true,
                  },
                ]
              : REMINDER_OPTIONS
          }
          onValueChange={(reminder) => onPatch({ reminder })}
          contentWidth="menu"
          triggerButton={
            <DateMentionControlRow
              icon={<BellIcon className="icon-2xs" />}
              label="Remind"
              value={getReminderLabel(payload.reminder)}
            />
          }
        />
      </div>

      <NodexDropdownSeparator paddingClassName="py-1" />

      <div className="px-1 pb-1">
        <DateMentionControlRow
          icon={<CheckmarkIcon className="icon-2xs" />}
          label="Use as card due date"
          disabled
        />
        <DateMentionControlRow
          icon={<CalendarIcon className="icon-2xs" />}
          label="Create scheduled card"
          disabled
        />
        <DateMentionControlRow
          icon={<CalendarIcon className="icon-2xs" />}
          label="Open project calendar"
          disabled
        />
      </div>
    </div>
  );
}

export function DateMentionInlineContentView({
  inlineContent,
  updateInlineContent,
  defaultOpen = false,
}: {
  inlineContent: { props: Partial<DateMentionProps> };
  updateInlineContent: (update: DateMentionInlineContentUpdate) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const props = normalizeDateMentionProps(inlineContent.props);
  const payload = dateMentionPropsToPayload(props);
  const title = formatDateMentionPlainText(payload);

  const handlePatch = (patch: DateMentionPatch) => {
    updateInlineContent(buildDateMentionUpdate(props, patch));
  };

  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <span className="inline align-baseline">
        <NodexPopoverAnchor>
          <span className="inline align-baseline">
            <DateMentionInlineVisual
              as="button"
              payload={payload}
              interactive
              withGuards
              contentEditable={false}
              title={title}
              aria-label={title}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onPointerEnter={() => {
                void preloadDateMentionCalendar();
              }}
              onFocus={() => {
                void preloadDateMentionCalendar();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpen((current) => !current);
              }}
            />
          </span>
        </NodexPopoverAnchor>
      </span>

      <NodexPopoverContent
        side="top"
        align="start"
        className="w-auto min-w-[180px] max-w-[calc(100vw-24px)] overflow-hidden p-0 [animation-duration:200ms] [animation-timing-function:ease]"
        initialFocus={false}
      >
        <DateMentionPopoverBody props={props} onPatch={handlePatch} />
      </NodexPopoverContent>
    </NodexPopover>
  );
}
