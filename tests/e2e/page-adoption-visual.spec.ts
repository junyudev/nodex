import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { launchReviewSeed, openLaunchReview } from "./support/page-launch-review";

test("a Visual data cell rewrites one source literal and updates the bar tooltip", async () => {
  await withElectronScenario(
    { label: "page-adoption-visual", ...launchReviewSeed },
    async ({ page, manifest }) => {
      const stage = await openLaunchReview(page, manifest);
      const blockId = manifest?.entityIdsByKey?.adoptionVisual;
      if (!blockId) throw new Error("The launch review fixture has no adoption Visual");
      const visual = stage.locator(`[data-nfm-code-block-surface][data-block-id="${blockId}"]`);
      const frame = visual.locator("[data-visual-frame]");
      const source = visual.locator("[data-nfm-code-source-region] code");
      const tooltip = visual.getByRole("tooltip");

      await expect(frame.locator("webview")).toBeVisible();
      // The fixture's 520 × 300 SVG scales down to fit a narrower Page column.
      const box = await frame.boundingBox();
      if (!box) throw new Error("The adoption Visual has no frame");
      const scale = Math.min(1, box.width / 520);
      const at = (x: number, y: number) => ({ x: x * scale, y: y * scale });
      // Center of the Week 6 In-place Ask segment in SVG coordinates.
      const weekSixBar = { x: 356, y: 223 };
      await frame.hover({ position: at(weekSixBar.x, weekSixBar.y) });
      await expect(tooltip).toHaveText("Week 6 · In-place Ask 52");

      const originalSource = await source.textContent();
      expect(originalSource).toContain('"In-place Ask": 52');
      await visual.getByRole("button", { name: "Data", exact: true }).click();
      const row = visual
        .getByRole("row")
        .filter({ has: page.getByRole("cell", { name: "Week 6", exact: true }) });
      await row.getByRole("cell", { name: "52", exact: true }).dblclick();
      const input = row.getByRole("textbox", { name: "Value" });
      await input.fill("62");
      await input.press("Enter");
      await expect(row.getByRole("cell", { name: "62", exact: true })).toBeVisible();
      await expect
        .poll(() => source.textContent())
        .toBe(originalSource?.replace('"In-place Ask": 52', '"In-place Ask": 62'));

      await visual.getByRole("button", { name: "Data", exact: true }).click();
      // This point belongs to the segment only after its height increases.
      await frame.hover({ position: at(weekSixBar.x, 195) });
      await expect(tooltip).toHaveText("Week 6 · In-place Ask 62");
    },
  );
});
