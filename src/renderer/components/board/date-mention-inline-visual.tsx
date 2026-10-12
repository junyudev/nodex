import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { BellIcon } from "@/components/shared/icons";
import {
  dateMentionValueToIsoDate,
  dateMentionValueToTime,
  formatDateMentionLabel,
  isoDateToDate,
  todayIsoDate,
} from "@/lib/nfm/date-mention";
import { useDateMentionMinuteEpoch, useDateMentionTodayIso } from "@/lib/nfm/date-mention-clock";
import type { NfmDateMentionInlineContent } from "@/lib/nfm/types";
import { cn } from "@/lib/utils";

export type DateMentionReminderTone = "none" | "pending" | "overdue";

interface DateMentionInlineVisualBaseProps {
  payload: NfmDateMentionInlineContent;
  interactive?: boolean;
  withGuards?: boolean;
  labelClassName?: string;
  children?: never;
}

type DateMentionInlineVisualSpanProps = DateMentionInlineVisualBaseProps &
  Omit<ComponentPropsWithoutRef<"span">, "children"> & { as?: "span" };

type DateMentionInlineVisualButtonProps = DateMentionInlineVisualBaseProps &
  Omit<ComponentPropsWithoutRef<"button">, "children"> & { as: "button" };

export type DateMentionInlineVisualProps =
  | DateMentionInlineVisualSpanProps
  | DateMentionInlineVisualButtonProps;

export function resolveDateMentionReminderTone(
  payload: NfmDateMentionInlineContent,
  now: Date,
): DateMentionReminderTone {
  if (!payload.reminder) return "none";
  const date = dateMentionValueToIsoDate(payload.start) ?? todayIsoDate(now);
  const payloadTime = dateMentionValueToTime(payload.start);
  const time =
    payloadTime ??
    (payload.reminder.startsWith("day:") ? (payload.reminder.split("@")[1] ?? "09:00") : "23:59");
  const candidate = new Date(`${date}T${time}:00`);
  if (Number.isNaN(candidate.getTime())) return "pending";
  return candidate.getTime() < now.getTime() ? "overdue" : "pending";
}

export function DateMentionInlineVisual(props: DateMentionInlineVisualProps) {
  const isRelative = isRelativeDateMention(props.payload);
  const todayIso = useDateMentionTodayIso(isRelative);
  const minuteEpoch = useDateMentionMinuteEpoch(Boolean(props.payload.reminder));
  const labelNow = todayIso ? (isoDateToDate(todayIso) ?? undefined) : undefined;
  const label = formatDateMentionLabel(props.payload, labelNow ? { now: labelNow } : {});
  const reminderTone =
    props.payload.reminder && minuteEpoch !== null
      ? resolveDateMentionReminderTone(props.payload, new Date(minuteEpoch))
      : "none";

  if (props.as === "button") {
    const {
      as: Element,
      payload,
      interactive,
      withGuards,
      labelClassName,
      className,
      ...buttonProps
    } = props;
    const chip = (
      <Element
        type={buttonProps.type ?? "button"}
        className={cn(
          "notion-reminder inline-flex max-w-full items-baseline whitespace-nowrap rounded-[2px] font-medium align-baseline outline-hidden",
          "focus-visible:ring-token-focus-border focus-visible:ring-2",
          interactive && "cursor-interaction hover:bg-token-foreground/5",
          reminderTone === "pending" && "text-(--blue-300)",
          reminderTone === "overdue" && "text-token-charts-red",
          className,
        )}
        data-date-mention-chip="true"
        data-reminder-tone={reminderTone}
        {...buttonProps}
      >
        <DateMentionInlineVisualChildren
          payload={payload}
          label={label}
          labelClassName={labelClassName}
        />
      </Element>
    );

    return withGuards ? wrapDateMentionInlineGuards(chip) : chip;
  }

  const {
    as: Element = "span",
    payload,
    interactive,
    withGuards,
    labelClassName,
    className,
    ...spanProps
  } = props;
  const chip = (
    <Element
      className={cn(
        "notion-reminder inline-flex max-w-full items-baseline whitespace-nowrap rounded-[2px] font-medium align-baseline text-inherit",
        interactive && "cursor-interaction hover:bg-token-foreground/5",
        reminderTone === "pending" && "text-(--blue-300)",
        reminderTone === "overdue" && "text-token-charts-red",
        className,
      )}
      data-date-mention-chip="true"
      data-reminder-tone={reminderTone}
      {...spanProps}
    >
      <DateMentionInlineVisualChildren
        payload={payload}
        label={label}
        labelClassName={labelClassName}
      />
    </Element>
  );

  return withGuards ? wrapDateMentionInlineGuards(chip) : chip;
}

function wrapDateMentionInlineGuards(chip: ReactNode) {
  return (
    <span className="inline align-baseline" data-date-mention-inline-root="true">
      <span
        aria-hidden="true"
        className="inline-block w-0 overflow-hidden align-baseline"
        data-date-mention-guard="start"
      />
      {chip}
      <span
        aria-hidden="true"
        className="inline-block w-0 overflow-hidden align-baseline"
        data-date-mention-guard="end"
      />
    </span>
  );
}

function DateMentionInlineVisualChildren({
  payload,
  label,
  labelClassName,
}: {
  payload: NfmDateMentionInlineContent;
  label: ReactNode;
  labelClassName?: string;
}) {
  return (
    <>
      <span className="leading-[inherit] opacity-50">@</span>
      <span className={cn("min-w-0 truncate leading-[inherit]", labelClassName)}>{label}</span>
      {payload.reminder ? (
        <BellIcon className="ml-[0.25em] inline-block size-[0.95em] shrink-0 self-center opacity-80" />
      ) : null}
    </>
  );
}

function isRelativeDateMention(payload: NfmDateMentionInlineContent): boolean {
  return !payload.format || payload.format === "relative";
}
