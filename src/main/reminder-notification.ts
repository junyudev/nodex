import { getMainIntl } from "./i18n/main-intl";

export interface ReminderNotificationPayload {
  readonly projectId: string;
  readonly pageId: string;
  readonly occurrenceStart: string;
  readonly title: string;
  readonly body: string;
  readonly reminderOffsetMinutes: number;
}

export function formatReminderBody(occurrenceStart: Date, offsetMinutes: number): string {
  if (offsetMinutes < 0)
    return getMainIntl().formatMessage({
      id: "main.notification.scheduledReminder.snoozed",
      defaultMessage: "Snoozed reminder",
    });
  if (offsetMinutes === 0)
    return getMainIntl().formatMessage({
      id: "main.notification.scheduledReminder.now",
      defaultMessage: "Starts now",
    });
  if (offsetMinutes < 60) {
    return getMainIntl().formatMessage(
      {
        id: "main.notification.scheduledReminder.minutes",
        defaultMessage: "Starts in {count, plural, one {# minute} other {# minutes}}",
      },
      { count: offsetMinutes },
    );
  }
  const hours = Math.floor(offsetMinutes / 60);
  if (offsetMinutes % 60 === 0 && hours < 24) {
    return getMainIntl().formatMessage(
      {
        id: "main.notification.scheduledReminder.hours",
        defaultMessage: "Starts in {count, plural, one {# hour} other {# hours}}",
      },
      { count: hours },
    );
  }
  const days = Math.floor(offsetMinutes / (60 * 24));
  if (offsetMinutes % (60 * 24) === 0) {
    return getMainIntl().formatMessage(
      {
        id: "main.notification.scheduledReminder.days",
        defaultMessage: "Starts in {count, plural, one {# day} other {# days}}",
      },
      { count: days },
    );
  }
  const intl = getMainIntl();
  const timeOptions = { hour: "numeric", minute: "2-digit" } as const;
  const time =
    intl.locale === "en-US"
      ? occurrenceStart.toLocaleTimeString(undefined, timeOptions)
      : intl.formatTime(occurrenceStart, timeOptions);
  return getMainIntl().formatMessage(
    { id: "main.notification.scheduledReminder.at", defaultMessage: "Starts at {time}" },
    { time },
  );
}
