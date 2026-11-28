import type { Locator, Page } from "playwright";
import { openProjectBoard } from "../harness/project-board-ui";

import { WORKFLOW_STATUS_ORDER } from "../../../src/shared/workflow-status";
import type { ScenarioManifest } from "../contracts";
import { BOARD_DENSE_PRIMARY_PAGE_KEY } from "./board-dense";

export interface BoardDenseUiObservation {
  readonly totalCards: number;
  readonly cardsByStatus: Readonly<Record<string, number>>;
  readonly pageStageVisible: boolean;
  readonly editorVisible: boolean;
}

/** A Page Stage's body can contain independently editable Page references. */
export const pageStageBodyEditor = (stage: Locator): Locator =>
  stage.locator('.ProseMirror[contenteditable="true"]:not(.ProseMirror *)');

export const focusBoardDenseProjectHome = async (
  page: Page,
  manifest: ScenarioManifest,
): Promise<void> => {
  const primaryPageId = manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY];
  if (!primaryPageId) throw new Error("board/dense manifest has no primary Page");
  const primaryCard = page.locator(`[data-board-uuid-v7="${primaryPageId}"]`);
  if (await primaryCard.isVisible().catch(() => false)) return;
  await page
    .getByRole("button", {
      name: "Open Dense Board",
      exact: true,
    })
    .evaluate((element) => (element as HTMLElement).click());
  await openProjectBoard(page);
  await primaryCard.waitFor();
};

export const focusBoardDenseUi = async (
  page: Page,
  manifest: ScenarioManifest,
): Promise<Locator> => {
  const primaryPageId = manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY];
  if (!primaryPageId) throw new Error("board/dense manifest has no primary Page");
  const pageTab = page.getByRole("tab", { name: "Unify Database View rendering", exact: true });
  const stage = page.locator(`[data-page-stage-page-id="${primaryPageId}"]:visible`);
  if (!(await pageTab.isVisible()) || !(await stage.isVisible())) {
    await focusBoardDenseProjectHome(page, manifest);
    const primaryCard = page.locator(`[data-board-uuid-v7="${primaryPageId}"]`);
    await primaryCard
      .locator('[data-card-context-menu-trigger="true"]')
      .evaluate((element) => (element as HTMLElement).click());
    await pageTab.waitFor();
  }
  await pageStageBodyEditor(stage).waitFor();
  return stage;
};

export const observeBoardDenseUi = async (page: Page): Promise<BoardDenseUiObservation> => {
  const entries = await Promise.all(
    WORKFLOW_STATUS_ORDER.map(
      async (status) =>
        [
          status,
          await page
            .locator(
              `[data-board-column-root][data-board-column-id="${status}"] [data-board-uuid-v7]`,
            )
            .count(),
        ] as const,
    ),
  );
  const cardsByStatus = Object.fromEntries(entries);
  const stage = page.locator('[data-page-stage-surface="true"]:visible');
  return {
    totalCards: Object.values(cardsByStatus).reduce((total, count) => total + count, 0),
    cardsByStatus,
    pageStageVisible: await stage.isVisible(),
    editorVisible: await pageStageBodyEditor(stage).isVisible(),
  };
};
