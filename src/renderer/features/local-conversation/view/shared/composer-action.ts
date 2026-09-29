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
}

interface ResolvedComposerActionState {
  action: StageThreadsComposerAction;
  primarySubmitAction: StageThreadsComposerSubmitAction | null;
  alternateSubmitAction: StageThreadsComposerFollowUpAction | null;
  label: "Send prompt" | "Stop" | "Resume" | "Queue follow-up" | "Steer follow-up";
  disabled: boolean;
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
): ResolvedComposerActionState {
  if (input.busyAction === "interrupt") {
    return {
      action: "stop",
      primarySubmitAction: null,
      alternateSubmitAction: null,
      label: "Stop",
      disabled: true,
    };
  }

  if (input.busyAction === "resume") {
    return {
      action: "resume",
      primarySubmitAction: null,
      alternateSubmitAction: null,
      label: "Resume",
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
      label: "Stop",
      disabled: !input.canSendPrompt,
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
      label: "Resume",
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
        ? "Queue follow-up"
        : primarySubmitAction === "steer"
          ? "Steer follow-up"
          : "Send prompt",
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
