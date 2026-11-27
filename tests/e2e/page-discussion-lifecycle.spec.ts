import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  launchReviewSeed,
  openLaunchReview,
  reviewCard,
  reviewParagraph,
  selectReviewText,
  sendSelectedComment,
} from "./support/page-launch-review";

test("a text Comment can receive a reply, resolve, and reopen from Comments", async () => {
  await withElectronScenario(
    { label: "page-discussion-lifecycle", ...launchReviewSeed },
    async ({ page, manifest }) => {
      const stage = await openLaunchReview(page, manifest);
      const quote = "Compare four more weeks";
      const comment = "Can we include week 9 in the next review?";
      const reply = "Yes, the data will be ready on Monday.";

      await selectReviewText(page, reviewParagraph(stage, quote), quote);
      await sendSelectedComment(page, comment);
      const card = reviewCard(page, comment);
      await expect(card.getByText(comment, { exact: true })).toBeVisible();
      await card.getByRole("textbox").fill(reply);
      await card.getByRole("button", { name: "Send", exact: true }).click();
      await expect(card.getByText(reply, { exact: true })).toBeVisible();

      await card.getByRole("button", { name: "Resolve", exact: true }).click();
      await expect(card).toBeHidden();
      await page.getByRole("button", { name: "Comments", exact: true }).click();
      await page.getByRole("tab", { name: /^Resolved\b/u }).click();
      await page
        .getByRole("dialog", { name: "Comments" })
        .getByRole("button")
        .filter({ hasText: comment })
        .click();
      await expect(card.getByText(reply, { exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Reopen", exact: true }).click();
      await expect(card.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
    },
  );
});
