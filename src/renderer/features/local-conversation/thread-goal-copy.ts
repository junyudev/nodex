import {
  defineMessage,
  defineMessages,
  getIntl,
  type IntlShape,
  type MessageDescriptor,
} from "@/lib/i18n";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";

export const THREAD_GOAL_DEFAULT_MESSAGES = defineMessages({
  "composer.goalModeIndicator": {
    id: "conversation.threadGoalCopy.goalModeIndicator",
    defaultMessage: "Goal",
  },
  "composer.goalModeIndicator.clear": {
    id: "conversation.threadGoalCopy.goalModeIndicatorClear",
    defaultMessage: "Clear goal",
  },
  "composer.goalModeIndicator.tooltip": {
    id: "conversation.threadGoalCopy.goalModeIndicatorTooltip",
    defaultMessage: "Clear goal",
  },
  "composer.goalSlashCommand.setDescription": {
    id: "conversation.threadGoalCopy.goalSlashCommandSetDescription",
    defaultMessage: "Set a goal that Nodex will keep working towards",
  },
  "composer.goalSlashCommand.title": {
    id: "conversation.threadGoalCopy.goalSlashCommandTitle",
    defaultMessage: "Goal",
  },
  "composer.placeholder.goal": {
    id: "conversation.threadGoalCopy.placeholderGoal",
    defaultMessage: "Describe your goal, define measurable outcomes for best results",
  },
  "composer.threadGoal.clear": {
    id: "conversation.threadGoalCopy.threadGoalClear",
    defaultMessage: "Clear goal",
  },
  "composer.threadGoal.clearError": {
    id: "conversation.threadGoalCopy.threadGoalClearError",
    defaultMessage: "Failed to clear goal",
  },
  "composer.threadGoal.clearTooltip": {
    id: "conversation.threadGoalCopy.threadGoalClearTooltip",
    defaultMessage: "Clear goal",
  },
  "composer.threadGoal.collapseObjective": {
    id: "conversation.threadGoalCopy.threadGoalCollapseObjective",
    defaultMessage: "Hide full goal",
  },
  "composer.threadGoal.collapseObjectiveTooltip": {
    id: "conversation.threadGoalCopy.threadGoalCollapseObjectiveTooltip",
    defaultMessage: "Hide full goal",
  },
  "composer.threadGoal.edit": {
    id: "conversation.threadGoalCopy.threadGoalEdit",
    defaultMessage: "Edit goal",
  },
  "composer.threadGoal.editDialog.ariaLabel": {
    id: "conversation.threadGoalCopy.threadGoalEditDialogAriaLabel",
    defaultMessage: "Goal",
  },
  "composer.threadGoal.editDialog.cancel": {
    id: "conversation.threadGoalCopy.threadGoalEditDialogCancel",
    defaultMessage: "Cancel",
  },
  "composer.threadGoal.editDialog.save": {
    id: "conversation.threadGoalCopy.threadGoalEditDialogSave",
    defaultMessage: "Save",
  },
  "composer.threadGoal.editDialog.title": {
    id: "conversation.threadGoalCopy.threadGoalEditDialogTitle",
    defaultMessage: "Edit goal",
  },
  "composer.threadGoal.editLoadError": {
    id: "conversation.threadGoalCopy.threadGoalEditLoadError",
    defaultMessage: "Failed to load goal objective",
  },
  "composer.threadGoal.editSaveError": {
    id: "conversation.threadGoalCopy.threadGoalEditSaveError",
    defaultMessage: "Failed to save goal objective",
  },
  "composer.threadGoal.editTooltip": {
    id: "conversation.threadGoalCopy.threadGoalEditTooltip",
    defaultMessage: "Edit goal",
  },
  "composer.threadGoal.expandObjective": {
    id: "conversation.threadGoalCopy.threadGoalExpandObjective",
    defaultMessage: "Show full goal",
  },
  "composer.threadGoal.expandObjectiveTooltip": {
    id: "conversation.threadGoalCopy.threadGoalExpandObjectiveTooltip",
    defaultMessage: "Show full goal",
  },
  "composer.threadGoal.materializeError": {
    id: "conversation.threadGoalCopy.threadGoalMaterializeError",
    defaultMessage: "Failed to prepare goal attachments",
  },
  "composer.threadGoal.pause": {
    id: "conversation.threadGoalCopy.threadGoalPause",
    defaultMessage: "Pause goal",
  },
  "composer.threadGoal.pauseTooltip": {
    id: "conversation.threadGoalCopy.threadGoalPauseTooltip",
    defaultMessage: "Pause goal",
  },
  "composer.threadGoal.replaceConfirmation.cancel": {
    id: "conversation.threadGoalCopy.threadGoalReplaceConfirmationCancel",
    defaultMessage: "Cancel",
  },
  "composer.threadGoal.replaceConfirmation.confirm": {
    id: "conversation.threadGoalCopy.threadGoalReplaceConfirmationConfirm",
    defaultMessage: "Replace goal",
  },
  "composer.threadGoal.replaceConfirmation.subtitle": {
    id: "conversation.threadGoalCopy.threadGoalReplaceConfirmationSubtitle",
    defaultMessage:
      "This will keep the thread but replace the saved goal with your current composer text",
  },
  "composer.threadGoal.replaceConfirmation.title": {
    id: "conversation.threadGoalCopy.threadGoalReplaceConfirmationTitle",
    defaultMessage: "Replace current goal?",
  },
  "composer.threadGoal.resume": {
    id: "conversation.threadGoalCopy.threadGoalResume",
    defaultMessage: "Resume goal",
  },
  "composer.threadGoal.resumeConfirmation.dismissError": {
    id: "conversation.threadGoalCopy.threadGoalResumeConfirmationDismissError",
    defaultMessage: "Failed to dismiss goal prompt",
  },
  "composer.threadGoal.resumeConfirmation.keepPaused": {
    id: "conversation.threadGoalCopy.threadGoalResumeConfirmationKeepPaused",
    defaultMessage: "Keep paused",
  },
  "composer.threadGoal.resumeConfirmation.notNow": {
    id: "conversation.threadGoalCopy.threadGoalResumeConfirmationNotNow",
    defaultMessage: "Not now",
  },
  "composer.threadGoal.resumeConfirmation.resumableTitle": {
    id: "conversation.threadGoalCopy.threadGoalResumeConfirmationResumableTitle",
    defaultMessage: "Resume goal?",
  },
  "composer.threadGoal.resumeConfirmation.resume": {
    id: "conversation.threadGoalCopy.threadGoalResumeConfirmationResume",
    defaultMessage: "Resume goal",
  },
  "composer.threadGoal.resumeConfirmation.subtitle": {
    id: "conversation.threadGoalCopy.threadGoalResumeConfirmationSubtitle",
    defaultMessage: "Nodex will keep working toward this goal when the thread is idle",
  },
  "composer.threadGoal.resumeConfirmation.title": {
    id: "conversation.threadGoalCopy.threadGoalResumeConfirmationTitle",
    defaultMessage: "Resume paused goal?",
  },
  "composer.threadGoal.resumeTooltip": {
    id: "conversation.threadGoalCopy.threadGoalResumeTooltip",
    defaultMessage: "Resume goal",
  },
  "composer.threadGoal.setError": {
    id: "conversation.threadGoalCopy.threadGoalSetError",
    defaultMessage: "Failed to set goal",
  },
  "composer.threadGoal.statusUpdateError": {
    id: "conversation.threadGoalCopy.threadGoalStatusUpdateError",
    defaultMessage: "Failed to update goal",
  },
  "composer.threadGoal.summary.active": {
    id: "conversation.threadGoalCopy.threadGoalSummaryActive",
    defaultMessage: "Pursuing goal",
  },
  "composer.threadGoal.summary.blocked": {
    id: "conversation.threadGoalCopy.threadGoalSummaryBlocked",
    defaultMessage: "Goal blocked",
  },
  "composer.threadGoal.summary.budgetLimited": {
    id: "conversation.threadGoalCopy.threadGoalSummaryBudgetLimited",
    defaultMessage: "Goal limited",
  },
  "composer.threadGoal.summary.complete": {
    id: "conversation.threadGoalCopy.threadGoalSummaryComplete",
    defaultMessage: "Goal achieved",
  },
  "composer.threadGoal.summary.paused": {
    id: "conversation.threadGoalCopy.threadGoalSummaryPaused",
    defaultMessage: "Paused goal",
  },
  "composer.threadGoal.summary.usageLimited": {
    id: "conversation.threadGoalCopy.threadGoalSummaryUsageLimited",
    defaultMessage: "Goal usage limited",
  },
  "composer.threadGoal.tokenProgress": defineMessage<{ used: string; budget: string }>({
    id: "conversation.threadGoalCopy.threadGoalTokenProgress",
    defaultMessage: "{used} / {budget}",
  }),
});

export type ThreadGoalMessageId = keyof typeof THREAD_GOAL_DEFAULT_MESSAGES;

export const THREAD_GOAL_STATUS_LABELS: Record<ThreadGoal["status"], MessageDescriptor> = {
  active: THREAD_GOAL_DEFAULT_MESSAGES["composer.threadGoal.summary.active"],
  paused: THREAD_GOAL_DEFAULT_MESSAGES["composer.threadGoal.summary.paused"],
  blocked: THREAD_GOAL_DEFAULT_MESSAGES["composer.threadGoal.summary.blocked"],
  usageLimited: THREAD_GOAL_DEFAULT_MESSAGES["composer.threadGoal.summary.usageLimited"],
  budgetLimited: THREAD_GOAL_DEFAULT_MESSAGES["composer.threadGoal.summary.budgetLimited"],
  complete: THREAD_GOAL_DEFAULT_MESSAGES["composer.threadGoal.summary.complete"],
};

export function getThreadGoalMessage(
  messageId: ThreadGoalMessageId,
  intl: IntlShape = getIntl(),
): string {
  if (messageId === "composer.threadGoal.tokenProgress") {
    return intl.formatMessage(THREAD_GOAL_DEFAULT_MESSAGES[messageId], {
      used: "{used}",
      budget: "{budget}",
    });
  }
  return intl.formatMessage(THREAD_GOAL_DEFAULT_MESSAGES[messageId]);
}

export function formatThreadGoalStatusLabel(
  status: ThreadGoal["status"],
  intl: IntlShape = getIntl(),
): string {
  return intl.formatMessage(THREAD_GOAL_STATUS_LABELS[status]);
}

export function formatThreadGoalTokenProgress(
  input: { used: number; budget: number },
  intl: IntlShape = getIntl(),
): string {
  const options = { notation: "compact", maximumFractionDigits: 1 } as const;
  return intl.formatMessage(THREAD_GOAL_DEFAULT_MESSAGES["composer.threadGoal.tokenProgress"], {
    used: intl.formatNumber(input.used, options),
    budget: intl.formatNumber(input.budget, options),
  });
}
