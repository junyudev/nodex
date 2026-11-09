import type { ThreadComposerShellBackgroundAgentRowModel } from "../thread-stage-types";

type BackgroundSubagentSummaryRowCore = Pick<
  ThreadComposerShellBackgroundAgentRowModel,
  "showInlineActivity" | "status"
>;

export interface BackgroundSubagentCompactStripModel<T extends BackgroundSubagentSummaryRowCore> {
  displayRows: T[];
  workingCount: number;
  doneCount: number;
}

function isBackgroundSubpageWorking(row: BackgroundSubagentSummaryRowCore): boolean {
  return row.status !== "done";
}

export function buildBackgroundSubagentCompactStripModel<
  T extends BackgroundSubagentSummaryRowCore,
>(rows: readonly T[]): BackgroundSubagentCompactStripModel<T> {
  const inlineRows = rows.filter((row) => row.showInlineActivity);
  const workingRows = inlineRows.filter(isBackgroundSubpageWorking);
  const doneRows = inlineRows.filter((row) => row.status === "done");

  return {
    displayRows: workingRows.length > 0 ? workingRows.slice(0, 4) : doneRows.slice(0, 4),
    workingCount: workingRows.length,
    doneCount: doneRows.length,
  };
}

export function getBackgroundSubagentListRows<T extends BackgroundSubagentSummaryRowCore>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => !row.showInlineActivity);
}
