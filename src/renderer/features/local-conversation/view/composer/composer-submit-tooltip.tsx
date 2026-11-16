import { useIntl, type IntlShape } from "@/lib/i18n";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import type {
  StageThreadsComposerFollowUpAction,
  StageThreadsComposerSubmitAction,
} from "../shared/composer-action";

interface ComposerActionTooltipContentProps {
  action: "send" | "stop" | "resume";
  primarySubmitAction: StageThreadsComposerSubmitAction | null;
  alternateSubmitAction: StageThreadsComposerFollowUpAction | null;
  isThreadRunning: boolean;
  primaryShortcutKeys: readonly string[];
  alternateShortcutKeys: readonly string[];
}

export function ComposerActionTooltipContent(input: ComposerActionTooltipContentProps) {
  const intl = useIntl();
  if (input.action === "stop")
    return intl.formatMessage({
      id: "conversation.composerSubmitTooltip.stop",
      defaultMessage: "Stop",
    });
  if (input.action === "resume")
    return intl.formatMessage({
      id: "conversation.composerSubmitTooltip.resume",
      defaultMessage: "Resume",
    });
  if (
    !input.isThreadRunning ||
    input.primarySubmitAction === "send" ||
    !input.alternateSubmitAction
  ) {
    return intl.formatMessage({
      id: "conversation.composerSubmitTooltip.send",
      defaultMessage: "Send",
    });
  }

  const primaryAction: StageThreadsComposerFollowUpAction =
    input.primarySubmitAction === "queue" ? "queue" : "steer";

  return (
    <div className="grid grid-cols-[auto_auto] items-center gap-x-2 gap-y-1">
      <span className="text-token-foreground">
        {formatComposerSubmitActionLabel(intl, primaryAction)}
      </span>
      <span className="justify-self-end">
        <ShortcutKeycaps keys={input.primaryShortcutKeys} />
      </span>
      <span className="text-token-foreground">
        {formatComposerSubmitActionLabel(intl, input.alternateSubmitAction)}
      </span>
      <span className="justify-self-end">
        <ShortcutKeycaps keys={input.alternateShortcutKeys} />
      </span>
    </div>
  );
}

function formatComposerSubmitActionLabel(
  intl: IntlShape,
  action: StageThreadsComposerFollowUpAction,
) {
  return action === "queue"
    ? intl.formatMessage({
        id: "conversation.composerSubmitTooltip.queue",
        defaultMessage: "Queue",
      })
    : intl.formatMessage({
        id: "conversation.composerSubmitTooltip.steer",
        defaultMessage: "Steer",
      });
}
