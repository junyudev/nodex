import { defineMessage, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { DeniedCircleIcon, InfoIcon } from "@/components/shared/icons";
import type { CodexAnswerModerationNotice } from "../../../../../shared/codex-answer-moderation";

const MESSAGES = {
  cyber: defineMessage({
    id: "conversation.answerModeration.blockedCyber",
    defaultMessage: "This response was blocked by cybersecurity safeguards.",
  }),
  protection: defineMessage({
    id: "conversation.answerModeration.blocked",
    defaultMessage: "This response was blocked by safety safeguards.",
  }),
  withheld: defineMessage({
    id: "conversation.answerModeration.withheld",
    defaultMessage:
      "This response was hidden. If you're going through something difficult, you don't have to face it alone: reach out to someone you trust or a local helpline.",
  }),
  helpline: defineMessage({
    id: "conversation.answerModeration.helpline",
    defaultMessage:
      "If you're going through something difficult, you don't have to face it alone: reach out to someone you trust or a local helpline.",
  }),
} satisfies Record<string, MessageDescriptor>;

/** What a moderated final answer shows in place of, or after, its text. */
export function AnswerModerationNotice({ notice }: { notice: CodexAnswerModerationNotice }) {
  const intl = useIntl();
  const message = notice.kind === "blocked" ? MESSAGES[notice.reason] : MESSAGES[notice.kind];
  const Icon = notice.kind === "blocked" ? DeniedCircleIcon : InfoIcon;
  return (
    <p
      className="flex min-w-0 items-start gap-1.5 text-size-chat text-token-text-secondary"
      data-answer-moderation={notice.kind}
    >
      <Icon className="icon-xs mt-[0.2em] shrink-0" aria-hidden />
      <span className="min-w-0">{intl.formatMessage(message)}</span>
    </p>
  );
}
