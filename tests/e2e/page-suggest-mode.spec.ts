import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { invokeIpc } from "./support/editor-scenario";
import {
  launchReviewSeed,
  openLaunchReview,
  openReviewSuggestion,
  reviewParagraph,
  selectReviewText,
} from "./support/page-launch-review";

test("Suggesting sends a diff and only changes the Page after acceptance", async () => {
  await withElectronScenario(
    { label: "page-suggest-mode", ...launchReviewSeed },
    async ({ page, manifest }) => {
      if (!manifest) throw new Error("Missing launch review fixture");
      const stage = await openLaunchReview(page, manifest);
      const paragraph = reviewParagraph(stage, "Compare four more weeks");
      const original = await paragraph.innerText();
      const quote = "entry points.";
      const replacement = "channels in December.";
      const expected = original.replace(quote, replacement);

      await page.getByRole("button", { name: "Suggest edits instead of editing" }).click();
      await expect(
        page.getByRole("button", { name: "Stop suggesting and edit directly" }),
      ).toHaveAttribute("aria-pressed", "true");
      await selectReviewText(page, paragraph, quote);
      await page.keyboard.type(replacement);
      const bar = stage.locator("[data-suggestion-bar]");
      await expect(bar.getByText("1 suggested change", { exact: true })).toBeVisible();
      const privateDraft = await paragraph.innerText();
      await bar.getByRole("button", { name: "Suggest", exact: true }).click();

      const card = await openReviewSuggestion(page);
      const edit = card.locator('[data-suggested-edit="open"]');
      await expect(edit.locator("ins").filter({ hasText: "channels in December" })).toBeVisible();
      const discussionId = await card.getAttribute("data-discussion-card");
      if (!discussionId) throw new Error("Missing Suggested edit Discussion");
      const discussion = await invokeIpc(
        page,
        "library-module:read",
        { kind: "project", projectId: manifest.projectId },
        { read: { mode: "discussion", discussionId } },
      );
      if (!discussion.ok || discussion.value.value.kind !== "discussion") {
        throw new Error("Could not read the Page's stored Suggested edit");
      }
      const storedEdit = discussion.value.value.value.comments[0]?.suggestedEdit;
      expect({ privateDraft, storedEdit }).toMatchObject({
        privateDraft: expected,
        storedEdit: { oldMarkdown: original, newMarkdown: expected },
      });
      await expect(paragraph).toHaveText(original);
      await edit.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(paragraph).toHaveText(expected);
      await expect(card.locator('[data-suggested-edit="accepted"]')).toBeVisible();
    },
  );
});
