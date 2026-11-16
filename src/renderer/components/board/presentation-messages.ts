import { defineMessage, defineMessages, type IntlShape } from "@/lib/i18n";
import {
  DEFAULT_WORKFLOW_STATUS_LABEL_MESSAGES,
  isWorkflowStatus,
} from "../../../shared/workflow-status";

export const pageDescriptionPlaceholderMessage = defineMessage({
  id: "editor.nfmEditorPlaceholders.pageDescription",
  defaultMessage: "Add description...",
});

export const BOARD_SORT_FIELD_MESSAGES = defineMessages({
  "board-order": { id: "board.sortField.boardOrder", defaultMessage: "Board Order" },
  status: { id: "board.sortField.status", defaultMessage: "Status" },
  priority: { id: "board.sortField.priority", defaultMessage: "Priority" },
  estimate: { id: "board.sortField.estimate", defaultMessage: "Estimate" },
  created: { id: "board.sortField.created", defaultMessage: "Created" },
  title: { id: "board.sortField.title", defaultMessage: "Title" },
  tags: { id: "board.sortField.tags", defaultMessage: "Tags" },
  assignee: { id: "board.sortField.assignee", defaultMessage: "Assignee" },
});

export const BOARD_PRIORITY_LABEL_MESSAGES = defineMessages({
  "p0-critical": { id: "lib.priorityPresentation.critical", defaultMessage: "P0 - Critical" },
  "p1-high": { id: "lib.priorityPresentation.high", defaultMessage: "P1 - High" },
  "p2-medium": { id: "lib.priorityPresentation.medium", defaultMessage: "P2 - Medium" },
  "p3-low": { id: "lib.priorityPresentation.low", defaultMessage: "P3 - Low" },
});

export const TEXT_STYLE_MESSAGES = defineMessages({
  paragraph: { id: "lib.nfmTurnIntoTargets.text", defaultMessage: "Text" },
  "heading-1": { id: "lib.nfmTurnIntoTargets.headingOne", defaultMessage: "Heading 1" },
  "heading-2": { id: "lib.nfmTurnIntoTargets.headingTwo", defaultMessage: "Heading 2" },
  "heading-3": { id: "lib.nfmTurnIntoTargets.headingThree", defaultMessage: "Heading 3" },
  "bullet-list": { id: "lib.nfmTurnIntoTargets.bulletedList", defaultMessage: "Bulleted list" },
  "numbered-list": { id: "lib.nfmTurnIntoTargets.numberedList", defaultMessage: "Numbered list" },
  "todo-list": { id: "lib.nfmTurnIntoTargets.todoList", defaultMessage: "To-do list" },
  "toggle-list": { id: "lib.nfmTurnIntoTargets.toggleList", defaultMessage: "Toggle list" },
});

export function formatBoardWorkflowStatus(
  intl: IntlShape,
  statusId: string,
  options: readonly { readonly id: string; readonly name: string }[],
): string {
  return (
    options.find((option) => option.id === statusId)?.name ??
    (isWorkflowStatus(statusId)
      ? intl.formatMessage(DEFAULT_WORKFLOW_STATUS_LABEL_MESSAGES[statusId])
      : statusId)
  );
}
