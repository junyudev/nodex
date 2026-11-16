import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../scripts/scenarios/scenarios/board-dense";
import { focusBoardDenseUi } from "../../scripts/scenarios/scenarios/board-dense-ui";
import { createUuidV7 } from "../../src/shared/uuid-v7";

const primaryShortcut = (key: string): string =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

test("opens a Page body hit from the palette and continues through occurrences in Find", async () => {
  await withElectronScenario(
    { label: "page-search-reveal", scenarioId: BOARD_DENSE_SCENARIO_ID },
    async ({ page, seed, manifest }) => {
      if (!manifest) throw new Error("board/dense did not materialize");
      const title = "Page search reveal fixture";
      const pageId = createUuidV7();
      await seed.createPage({
        key: "searchReveal",
        projectId: manifest.projectId,
        pageId,
        operationId: createUuidV7(),
        status: "doing",
        title,
        markdown: [
          "准备迁移初稿",
          ...Array.from({ length: 50 }, (_, index) => `Context paragraph ${index + 1}.`),
          ":::toggle[Rollout details]\n\n迁移 方案已经准备好。\n\n:::",
        ].join("\n\n"),
      });
      await focusBoardDenseUi(page, manifest);

      const tab = page.getByRole("tab", { name: title, exact: true });
      await expect(tab).toHaveCount(0);
      const stage = page.locator(`[data-page-stage-page-id="${pageId}"]:visible`);
      const matchingBlock = stage.locator(".bn-block-content", {
        hasText: "迁移 方案已经准备好。",
      });
      const otherBlock = stage.locator(".bn-block-content", { hasText: "准备迁移初稿" });
      const find = stage.getByRole("textbox", { name: "Find in description" });
      const activeMark = ".nfm-search-match-active";

      const openHit = async (shortcut: string) => {
        await page.keyboard.press(primaryShortcut(shortcut));
        const palette = page.getByRole("dialog", { name: "Command palette" });
        const search = palette.getByRole("combobox", { name: "Command palette search" });
        await search.fill("迁移 方案");
        const result = palette.getByRole("option", { name: new RegExp(title, "u") });
        await expect(result).toBeVisible();
        // Select the result explicitly if unrelated All-scope actions precede it.
        if ((await result.getAttribute("aria-selected")) === "true") await search.press("Enter");
        else await result.click();
        await expect(palette).toBeHidden();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(find).toHaveValue("迁移");
        await expect(find).toBeFocused();
        await expect(matchingBlock.locator(activeMark)).toHaveText("迁移");
        await expect(matchingBlock.locator(activeMark)).toBeInViewport();
      };

      await openHit("P");
      await page.keyboard.press("Enter");
      await expect(otherBlock.locator(activeMark)).toBeInViewport();
      await page.keyboard.press(primaryShortcut("G"));
      await expect(matchingBlock.locator(activeMark)).toBeInViewport();

      await page.keyboard.press("Escape");
      await expect(find).toBeHidden();
      await expect(matchingBlock).toBeInViewport();

      // Reuse the existing tab with the target hidden inside a collapsed toggle.
      const toggle = stage.locator(".bn-toggle-wrapper", { hasText: "Rollout details" });
      await toggle.locator(".bn-toggle-button").click();
      await expect(matchingBlock).toBeHidden();
      await openHit("K");
      await expect(tab).toHaveCount(1);
    },
  );
});
