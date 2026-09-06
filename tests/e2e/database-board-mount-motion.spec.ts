import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../scripts/scenarios/scenarios/board-dense";
import { focusBoardDenseProjectHome } from "../../scripts/scenarios/scenarios/board-dense-ui";

test("keeps Board headers settled when a sibling tab group opens and closes", async () => {
  await withElectronScenario(
    { label: "board-mount-motion", scenarioId: BOARD_DENSE_SCENARIO_ID },
    async ({ page, manifest }) => {
      if (!manifest) throw new Error("Board fixture is missing");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await focusBoardDenseProjectHome(page, manifest);
      await page.getByRole("button", { name: "Sort View", exact: true }).click();
      await page.getByRole("button", { name: "Name", exact: true }).click();
      await expect(page.getByTestId("database-view-rules-bar")).toBeVisible();
      await page.keyboard.press("Escape");
      const build = page
        .locator('[data-database-board-column-header="true"]')
        .filter({ hasText: "Build" });
      await build.hover();
      await build.getByRole("button", { name: "More options for Build" }).click();
      const column = page.locator('[data-board-column-root][data-board-column-id="build"]');
      const expandedWidth = (await column.boundingBox())!.width;
      await column.evaluate((element) => {
        const widths: number[] = [];
        Object.assign(window, { boardCollapseWidths: widths });
        const sample = () => {
          const width = element.getBoundingClientRect().width;
          widths.push(width);
          if (element.isConnected && width !== 52) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.getByRole("button", { name: "Collapse column", exact: true }).click();
      await expect.poll(async () => (await column.boundingBox())?.width).toBe(52);
      const widths = await page.evaluate(
        () => (window as typeof window & { boardCollapseWidths: number[] }).boardCollapseWidths,
      );
      expect(widths.some((width) => width > 52 && width < expandedWidth)).toBe(true);

      await page.evaluate(() => {
        const seen = new WeakSet<Element>();
        const selector =
          '[data-database-board-column-header="true"], [data-testid="database-view-rules-bar"]';
        const observation = {
          minimumOpacity: 1,
          maximumTranslation: 0,
          initialElements: document.querySelectorAll(selector).length,
          mountedElements: 0,
          frames: 0,
          stopped: false,
        };
        Object.assign(window, { boardMountObservation: observation });
        const sample = () => {
          if (observation.stopped) return;
          observation.frames += 1;
          for (const header of document.querySelectorAll(selector)) {
            if (!seen.has(header)) {
              seen.add(header);
              observation.mountedElements += 1;
            }
            // Include the collapsed header's animated underlay as well as its label row.
            for (const element of [header, header.parentElement]) {
              if (!element) continue;
              const style = getComputedStyle(element);
              observation.minimumOpacity = Math.min(
                observation.minimumOpacity,
                Number(style.opacity),
              );
              const matrix = new DOMMatrixReadOnly(
                style.transform === "none" ? undefined : style.transform,
              );
              observation.maximumTranslation = Math.max(
                observation.maximumTranslation,
                Math.abs(matrix.m41),
                Math.abs(matrix.m42),
              );
            }
          }
          requestAnimationFrame(sample);
        };
        sample();
      });
      const branches = page.locator("[data-panel-group-branch-id]");
      const before = await branches.count();
      await page
        .getByRole("button", { name: "Open Page Clarify offline recovery copy", exact: true })
        .click();
      await expect(branches).toHaveCount(before + 1);
      await page
        .getByRole("tab", { name: "Clarify offline recovery copy", exact: true })
        .dblclick();
      await expect(
        page.getByRole("tab", { name: "Clarify offline recovery copy", exact: true }),
      ).not.toHaveAttribute("data-app-shell-tab-preview", "true");
      await page
        .getByRole("button", { name: "Close Clarify offline recovery copy tab", exact: true })
        .click();
      await expect(branches).toHaveCount(before);
      const observation = await page.evaluate(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const result = (
          window as typeof window & {
            boardMountObservation: {
              minimumOpacity: number;
              maximumTranslation: number;
              initialElements: number;
              mountedElements: number;
              frames: number;
              stopped: boolean;
            };
          }
        ).boardMountObservation;
        result.stopped = true;
        return result;
      });
      expect(observation.frames).toBeGreaterThan(2);
      expect(observation.initialElements).toBeGreaterThan(1);
      expect(observation.mountedElements).toBeGreaterThan(observation.initialElements * 2);
      expect(observation.minimumOpacity).toBe(1);
      expect(observation.maximumTranslation).toBe(0);
      await expect(column).toHaveAttribute("data-board-column-collapsed", "true");
      await expect(page.getByTestId("database-view-rules-bar")).toBeVisible();
    },
  );
});
