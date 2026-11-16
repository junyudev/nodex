import { getIntl } from "@/lib/i18n";
import { resolveThreadInProgressFollowUpMode } from "@/lib/thread-composer-follow-up-mode";
import type { ComposerEnterBehavior } from "@/lib/composer-enter-behavior";

export type StageThreadsBusyAction =
  | "send"
  | "interrupt"
  | "resume"
  | "login"
  | "refresh"
  | "logout"
  | null;
export type StageThreadsComposerAction = "send" | "stop" | "resume";
export type StageThreadsComposerSubmitAction = "send" | "queue" | "steer";
export type StageThreadsComposerFollowUpAction = Exclude<StageThreadsComposerSubmitAction, "send">;

interface ResolveComposerActionInput {
  canSendPrompt: boolean;
  isThreadRunning: boolean;
  busyAction: StageThreadsBusyAction;
  hasDraftContent: boolean;
  hasThreadGoal: boolean;
  isQueueingEnabled: boolean;
  supportsRunningFollowUps?: boolean;
  latestTurnStatus: "inProgress" | "completed" | "interrupted" | "failed" | null;
  canResumeInterruptedTurn: boolean;
  /** Why this reader may not stop the Run, as in a hosted chat another Member asked it for. */
  interruptUnavailableReason?: string | null;
}

interface ResolvedComposerActionState {
  action: StageThreadsComposerAction;
  primarySubmitAction: StageThreadsComposerSubmitAction | null;
  alternateSubmitAction: StageThreadsComposerFollowUpAction | null;
  label: string;
  disabled: boolean;
  /** Why the action is unavailable to this reader, shown where it would be. */
  unavailableReason?: string;
}

interface ResolveComposerSubmitIntentInput {
  enterBehavior: ComposerEnterBehavior;
  hasMultilinePrompt: boolean;
  isThreadRunning: boolean;
  primarySubmitAction: StageThreadsComposerSubmitAction | null;
  alternateSubmitAction: StageThreadsComposerFollowUpAction | null;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

interface ResolvedComposerSubmitIntent {
  submitAction: StageThreadsComposerSubmitAction;
  shortcutRole: "primary" | "alternate";
}

export function resolveStageThreadsComposerActionState(
  input: ResolveComposerActionInput,
  intl = getIntl(),
): ResolvedComposerActionState {
  if (input.busyAction === "interrupt") {
    return {
      action: "stop",
      primarySubmitAction: null,
      alternateSubmitAction: null,
      label: intl.formatMessage({ id: "conversation.composerAction.stop", defaultMessage: "Stop" }),
      disabled: true,
    };
  }

  if (input.busyAction === "resume") {
    return {
      action: "resume",
      primarySubmitAction: null,
      alternateSubmitAction: null,
      label: intl.formatMessage({
        id: "conversation.composerAction.resume",
        defaultMessage: "Resume",
      }),
      disabled: true,
    };
  }

  if (
    input.isThreadRunning &&
    (!input.hasDraftContent || input.supportsRunningFollowUps === false)
  ) {
    return {
      action: "stop",
      primarySubmitAction: null,
      alternateSubmitAction: null,
      label: intl.formatMessage({ id: "conversation.composerAction.stop", defaultMessage: "Stop" }),
      disabled: !input.canSendPrompt || Boolean(input.interruptUnavailableReason),
      ...(input.interruptUnavailableReason
        ? { unavailableReason: input.interruptUnavailableReason }
        : {}),
    };
  }

  if (
    input.canResumeInterruptedTurn &&
    input.canSendPrompt &&
    !input.isThreadRunning &&
    input.latestTurnStatus === "interrupted" &&
    !input.hasThreadGoal &&
    !input.hasDraftContent &&
    input.busyAction === null
  ) {
    return {
      action: "resume",
      primarySubmitAction: null,
      alternateSubmitAction: null,
      label: intl.formatMessage({
        id: "conversation.composerAction.resume",
        defaultMessage: "Resume",
      }),
      disabled: false,
    };
  }

  const primarySubmitAction = input.isThreadRunning
    ? resolveThreadInProgressFollowUpMode({ isQueueingEnabled: input.isQueueingEnabled })
    : "send";

  return {
    action: "send",
    primarySubmitAction,
    alternateSubmitAction: input.isThreadRunning
      ? resolveThreadInProgressFollowUpMode({
          invertInProgressFollowUpMode: true,
          isQueueingEnabled: input.isQueueingEnabled,
        })
      : null,
    label:
      primarySubmitAction === "queue"
        ? intl.formatMessage({
            id: "conversation.composerAction.queue",
            defaultMessage: "Queue follow-up",
          })
        : primarySubmitAction === "steer"
          ? intl.formatMessage({
              id: "conversation.composerAction.steer",
              defaultMessage: "Steer follow-up",
            })
          : intl.formatMessage({
              id: "conversation.composerAction.send",
              defaultMessage: "Send prompt",
            }),
    disabled: !input.canSendPrompt || input.busyAction !== null || !input.hasDraftContent,
  };
}

export function resolveComposerSubmitIntentFromKeyDown(
  input: ResolveComposerSubmitIntentInput,
): ResolvedComposerSubmitIntent | null {
  if (input.isComposing || input.key !== "Enter" || input.altKey) return null;

  if (
    input.isThreadRunning &&
    input.alternateSubmitAction &&
    matchesAlternateSubmitShortcut(input)
  ) {
    return {
      submitAction: input.alternateSubmitAction,
      shortcutRole: "alternate",
    };
  }

  if (!input.primarySubmitAction || !matchesPrimarySubmitShortcut(input)) return null;

  return {
    submitAction: input.primarySubmitAction,
    shortcutRole: "primary",
  };
}

function matchesAlternateSubmitShortcut(
  input: Pick<
    ResolveComposerSubmitIntentInput,
    "enterBehavior" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
): boolean {
  const hasModifier = input.ctrlKey || input.metaKey;
  if (!hasModifier) return false;

  if (input.enterBehavior === "enter") {
    return !input.shiftKey;
  }

  return input.shiftKey;
}

function matchesPrimarySubmitShortcut(
  input: Pick<
    ResolveComposerSubmitIntentInput,
    "enterBehavior" | "hasMultilinePrompt" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
): boolean {
  const hasModifier = input.ctrlKey || input.metaKey;

  if (input.enterBehavior === "enter") {
    return !input.shiftKey;
  }

  if (input.hasMultilinePrompt) {
    return hasModifier && !input.shiftKey;
  }

  return !hasModifier && !input.shiftKey;
}
