import { expect, type Locator, type Page } from "@playwright/test";
import type { ScenarioManifest } from "../../../scripts/scenarios/contracts";
import { openProjectBoard } from "../../../scripts/scenarios/harness/project-board-ui";
import {
  LAUNCH_REVIEW_PAGE_KEY,
  LAUNCH_REVIEW_PROJECT,
  LAUNCH_REVIEW_TITLE,
  PAGE_ASKS_AND_COMMENTS_ID,
} from "../../../scripts/scenarios/scenarios/page-asks-and-comments";
import { openBoardPageFromCard } from "./open-board-page";

export const launchReviewSeed = {
  scenarioId: PAGE_ASKS_AND_COMMENTS_ID,
  seedThrough: "core",
} as const;

export async function openLaunchReview(page: Page, manifest: ScenarioManifest | null) {
  const pageId = manifest?.pageIdsByKey[LAUNCH_REVIEW_PAGE_KEY];
  if (!pageId) throw new Error("The launch review fixture has no Page");
  await page.getByRole("button", { name: `Open ${LAUNCH_REVIEW_PROJECT}`, exact: true }).click();
  await openProjectBoard(page);
  await openBoardPageFromCard({
    page,
    card: page.locator(`[data-board-uuid-v7="${pageId}"]`),
    tabName: LAUNCH_REVIEW_TITLE,
  });
  return page.locator(`[data-page-stage-page-id="${pageId}"]:visible`);
}

export function reviewParagraph(stage: Locator, text: string) {
  return stage.locator(".ProseMirror p").filter({ hasText: text });
}

/** Extend a real editor selection with arrow keys so wrapped quotes select reliably. */
export async function selectReviewText(page: Page, paragraph: Locator, quote: string) {
  const start = await paragraph.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent?.includes(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    const node = walker.nextNode();
    if (!node?.textContent) throw new Error(`Missing launch review selection: ${text}`);
    const offset = node.textContent.indexOf(text);
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const first = range.getBoundingClientRect();
    const block = element.getBoundingClientRect();
    return { x: first.left - block.left + 1, y: first.y - block.y + first.height / 2 };
  }, quote);
  await paragraph.click({ position: start });
  await page.keyboard.down("Shift");
  try {
    for (const _character of quote) await page.keyboard.press("ArrowRight");
  } finally {
    await page.keyboard.up("Shift");
  }
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(quote);
}

export function reviewCard(page: Page, text: string) {
  return page.locator("[data-discussion-card]").filter({ hasText: text });
}

export async function sendSelectedComment(page: Page, body: string) {
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "Comment on the selection" });
  await composer.getByRole("textbox").fill(body);
  await composer.getByRole("button", { name: "Send", exact: true }).click();
}

/** In a compact margin a submitted suggestion is represented by a marker until opened. */
export async function openReviewSuggestion(page: Page) {
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("tab", { name: /^Open\b/u }).click();
  await page
    .getByRole("button")
    .filter({ has: page.getByText("Suggested edit", { exact: true }) })
    .click();
  return reviewCard(page, "Suggested edit");
}
