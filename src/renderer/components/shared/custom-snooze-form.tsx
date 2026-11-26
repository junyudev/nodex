import { useIntl } from "@/lib/i18n";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ClockIcon } from "@/components/shared/icons";
import { NodexDateCalendar } from "@/components/ui/date-calendar";
import {
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { formatChatSnoozeTime } from "@/lib/chat-snooze";
import {
  earliestSnoozeInstant,
  initialSnoozeDraft,
  parseSnoozePhrase,
  snoozeDraftInstant,
  snoozeDraftIsPast,
  snoozeDraftOnDay,
  snoozeTimeSlots,
  type SnoozeDraft,
} from "@/lib/custom-snooze-time";
import { cn } from "@/lib/utils";

const startOfMonth = (day: Date) => new Date(day.getFullYear(), day.getMonth(), 1);
const monthKey = (day: Date) => day.getFullYear() * 12 + day.getMonth();
const startOfDay = (instant: Date) =>
  new Date(instant.getFullYear(), instant.getMonth(), instant.getDate());

/**
 * Picks any later date and time to snooze until, in the person's own time zone: typed as a
 * phrase such as "fri 3pm", or chosen on the calendar and the list of times beside it. Whichever
 * the person used last decides, and the footer says when the item comes back.
 */
export function CustomSnoozeForm({
  onChoose,
}: {
  readonly onChoose: (snoozedUntil: string) => void;
}) {
  const intl = useIntl();
  // Every rule reads the moment the dialog opened, so the choices hold still while it is open.
  const [openedAt] = useState(() => new Date());
  const [picked, setPicked] = useState(() => initialSnoozeDraft(openedAt));
  const [phrase, setPhrase] = useState("");
  const parsed = parseSnoozePhrase(phrase, openedAt, intl.locale, picked.minutes);
  const draft = parsed.kind === "time" ? parsed.draft : picked;
  const past = snoozeDraftIsPast(draft, openedAt);
  const ready = parsed.kind !== "unreadable" && !past;

  // The calendar follows the chosen day across months, and otherwise stays where it was browsed.
  const [month, setMonth] = useState(() => startOfMonth(draft.day));
  const [shownMonthKey, setShownMonthKey] = useState(() => monthKey(draft.day));
  if (shownMonthKey !== monthKey(draft.day)) {
    setShownMonthKey(monthKey(draft.day));
    setMonth(startOfMonth(draft.day));
  }

  const pick = (next: SnoozeDraft) => {
    setPicked(next);
    setPhrase("");
  };
  const minDay = startOfDay(earliestSnoozeInstant(openedAt));
  const slots = snoozeTimeSlots(draft, openedAt, intl.locale);
  const when = formatChatSnoozeTime(snoozeDraftInstant(draft).toISOString(), openedAt, intl.locale);

  return (
    <NodexDialogForm
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onChoose(snoozeDraftInstant(draft).toISOString());
      }}
    >
      <NodexDialogHeader>
        <NodexDialogTitle>
          {intl.formatMessage({
            id: "shared.snoozeMenu.customTitle",
            defaultMessage: "Snooze until",
          })}
        </NodexDialogTitle>
      </NodexDialogHeader>
      <NodexDialogBody>
        <label className="flex h-8 items-center gap-2 rounded-lg bg-token-foreground/5 px-2.5">
          <ClockIcon className="icon-xs shrink-0 text-token-description-foreground" />
          <input
            autoFocus
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            aria-label={intl.formatMessage({
              id: "shared.snoozeMenu.customTime",
              defaultMessage: "Date and time",
            })}
            aria-invalid={parsed.kind === "unreadable"}
            placeholder={intl.formatMessage({
              id: "shared.snoozeMenu.customPhrasePlaceholder",
              defaultMessage: "Type a time, like “fri 3pm” or “in 2 days”",
            })}
            spellCheck={false}
            autoComplete="off"
            data-app-action-snooze-custom-time=""
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-token-foreground outline-hidden placeholder:text-token-description-foreground"
          />
        </label>
      </NodexDialogBody>
      <NodexDialogBody>
        <div className="-mx-2 flex">
          <div className="w-60 shrink-0">
            <NodexDateCalendar
              selected={draft.day}
              month={month}
              minDate={minDay}
              onMonthChange={setMonth}
              onToday={() => pick(snoozeDraftOnDay(startOfDay(openedAt), draft.minutes, openedAt))}
              onSelect={(day) => {
                if (day) pick(snoozeDraftOnDay(day, draft.minutes, openedAt));
              }}
            />
          </div>
          <div className="my-1 w-px shrink-0 bg-token-foreground/8" />
          <SnoozeTimeList
            slots={slots}
            selected={draft.minutes}
            label={intl.formatMessage({ id: "shared.snoozeMenu.time", defaultMessage: "Time" })}
            onSelect={(minutes) => pick({ day: draft.day, minutes })}
          />
        </div>
      </NodexDialogBody>
      <NodexDialogBody>
        <div className="flex items-center gap-3">
          <p aria-live="polite" className="min-w-0 flex-1 truncate text-sm">
            {parsed.kind === "unreadable" ? (
              <span className="text-token-description-foreground">
                {intl.formatMessage({
                  id: "shared.snoozeMenu.unreadablePhrase",
                  defaultMessage: "Couldn’t read that time",
                })}
              </span>
            ) : past ? (
              <span className="text-token-description-foreground">
                {intl.formatMessage({
                  id: "shared.snoozeMenu.pastTime",
                  defaultMessage: "That time has passed",
                })}
              </span>
            ) : (
              <>
                <span className="text-token-description-foreground">
                  {intl.formatMessage({
                    id: "shared.snoozeMenu.returns",
                    defaultMessage: "Returns",
                  })}
                </span>{" "}
                <span className="text-token-foreground">{when}</span>
              </>
            )}
          </p>
          <NodexDialogAction type="submit" tone="primary" disabled={!ready}>
            {intl.formatMessage({ id: "shared.snoozeMenu.snooze", defaultMessage: "Snooze" })}
          </NodexDialogAction>
        </div>
      </NodexDialogBody>
    </NodexDialogForm>
  );
}

const SLOT_ID_PREFIX = "custom-snooze-time-";

/**
 * The times of the chosen day, as one listbox: the arrow keys move the choice through the times
 * still ahead, and the chosen time stays in view as the day or the typed phrase changes it.
 */
function SnoozeTimeList({
  slots,
  selected,
  label,
  onSelect,
}: {
  readonly slots: readonly { minutes: number; label: string; disabled: boolean }[];
  readonly selected: number;
  readonly label: string;
  readonly onSelect: (minutes: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const centered = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-minutes="${selected}"]`);
    if (!list || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    // A time that arrives from afar, and the first look, sit in the middle with times on either
    // side; a step to the edge scrolls just enough to keep a neighbor in view past the fade.
    if (!centered.current || bottom <= viewTop || top >= viewBottom) {
      centered.current = true;
      list.scrollTop = top - (list.clientHeight - row.offsetHeight) / 2;
      return;
    }
    const margin = row.offsetHeight;
    if (top - margin < viewTop) list.scrollTop = top - margin;
    else if (bottom + margin > viewBottom) list.scrollTop = bottom + margin - list.clientHeight;
  }, [selected]);

  const enabled = slots.filter((slot) => !slot.disabled);
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      // Enter confirms the chosen time, as it does from the typed phrase.
      event.preventDefault();
      event.currentTarget.closest("form")?.requestSubmit();
      return;
    }
    const index = enabled.findIndex((slot) => slot.minutes === selected);
    const target =
      event.key === "ArrowDown"
        ? enabled[Math.min(index + 1, enabled.length - 1)]
        : event.key === "ArrowUp"
          ? enabled[Math.max(index - 1, 0)]
          : event.key === "Home"
            ? enabled[0]
            : event.key === "End"
              ? enabled.at(-1)
              : undefined;
    if (!target) return;
    event.preventDefault();
    onSelect(target.minutes);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={`${SLOT_ID_PREFIX}${selected}`}
        onKeyDown={step}
        className={cn(
          "vertical-scroll-fade-mask hide-scrollbar absolute inset-0 overflow-y-auto overscroll-contain px-2 py-1 outline-hidden [--edge-fade-distance:1.5rem]",
          "focus-visible:[&_[aria-selected=true]]:ring-2 focus-visible:[&_[aria-selected=true]]:ring-token-focus-border",
        )}
      >
        {slots.map((slot) => (
          <div
            key={slot.minutes}
            id={`${SLOT_ID_PREFIX}${slot.minutes}`}
            role="option"
            data-minutes={slot.minutes}
            aria-selected={slot.minutes === selected}
            aria-disabled={slot.disabled || undefined}
            onClick={() => {
              if (!slot.disabled) onSelect(slot.minutes);
            }}
            className={cn(
              "flex h-7 shrink-0 cursor-interaction items-center rounded-md px-2 text-sm tabular-nums",
              slot.minutes === selected
                ? slot.disabled
                  ? "bg-token-foreground/8 text-token-description-foreground"
                  : "bg-chart-blue text-(--app-color-text-on-accent)"
                : slot.disabled
                  ? "cursor-default text-token-description-foreground/35"
                  : "text-token-foreground hover:bg-token-list-hover-background",
            )}
          >
            {slot.label}
          </div>
        ))}
      </div>
    </div>
  );
}
