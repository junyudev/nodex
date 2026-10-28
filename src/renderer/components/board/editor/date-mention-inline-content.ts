import {
  createDateMentionPayload,
  normalizeDateMention,
  todayIsoDate,
  type DateMentionDateFormat,
  type DateMentionTimeFormat,
} from "../../../../shared/rich-text/date-mention";
import type { DateMentionInlineContent } from "../../../../shared/rich-text/date-mention";

export interface DateMentionProps {
  start: string;
  end: string;
  tz: string;
  format: string;
  timeFormat: string;
  reminder: string;
}

export interface DateMentionInlineContentUpdate {
  type: "dateMention";
  props: DateMentionProps;
}

export type DateMentionPatch = Partial<DateMentionProps>;

const EMPTY_DATE_MENTION_PROPS: DateMentionProps = {
  start: "",
  end: "",
  tz: "",
  format: "",
  timeFormat: "",
  reminder: "",
};

export function normalizeDateMentionProps(
  input: Partial<DateMentionProps> | undefined,
): DateMentionProps {
  return {
    ...EMPTY_DATE_MENTION_PROPS,
    start: typeof input?.start === "string" ? input.start : "",
    end: typeof input?.end === "string" ? input.end : "",
    tz: typeof input?.tz === "string" ? input.tz : "",
    format: typeof input?.format === "string" ? input.format : "",
    timeFormat: typeof input?.timeFormat === "string" ? input.timeFormat : "",
    reminder: typeof input?.reminder === "string" ? input.reminder : "",
  };
}

export function dateMentionPayloadToProps(payload: DateMentionInlineContent): DateMentionProps {
  return {
    start: payload.start,
    end: payload.end ?? "",
    tz: payload.tz ?? "",
    format: payload.format ?? "",
    timeFormat: payload.timeFormat ?? "",
    reminder: payload.reminder ?? "",
  };
}

export function dateMentionPropsToPayload(
  props: Partial<DateMentionProps> | undefined,
): DateMentionInlineContent {
  const normalizedProps = normalizeDateMentionProps(props);
  const payload = normalizeDateMention({
    type: "dateMention",
    start: normalizedProps.start,
    end: normalizedProps.end,
    tz: normalizedProps.tz,
    format: normalizedProps.format as DateMentionDateFormat,
    timeFormat: normalizedProps.timeFormat as DateMentionTimeFormat,
    reminder: normalizedProps.reminder,
  });

  return payload ?? createDateMentionPayload(todayIsoDate());
}

export function buildDateMentionUpdate(
  current: Partial<DateMentionProps> | undefined,
  patch: DateMentionPatch,
): DateMentionInlineContentUpdate {
  const currentPayload = dateMentionPropsToPayload(current);
  const nextProps = normalizeDateMentionProps({
    ...dateMentionPayloadToProps(currentPayload),
    ...patch,
  });
  const nextPayload = dateMentionPropsToPayload(nextProps);
  return {
    type: "dateMention",
    props: dateMentionPayloadToProps(nextPayload),
  };
}
