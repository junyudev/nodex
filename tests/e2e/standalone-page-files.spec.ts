import { expect, test, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  PAGE_RELOCATION_SCENARIO_ID,
  requirePageRelocationScenarioFacts,
} from "../../scripts/scenarios/scenarios/page-relocation";
import type { IpcApi } from "../../src/shared/ipc-api";
import { writeTestClipboardImage } from "./clipboard";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const readPageFiles = async (page: Page, pageId: string) =>
  await page.evaluate(async (targetPageId) => {
    const api = (
      window as unknown as {
        api: {
          invoke(
            channel: "library-module:read",
            ...args: IpcApi["library-module:read"]["args"]
          ): Promise<IpcApi["library-module:read"]["result"]>;
        };
      }
    ).api;
    const result = await api.invoke(
      "library-module:read",
      { kind: "library" },
      { read: { mode: "page_file_inventory", page_id: targetPageId, limit: 10 } },
    );
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.value.kind !== "page_file_inventory") {
      throw new Error("Expected Page File inventory");
    }
    return result.value.value.value;
  }, pageId);

test("persists a pasted image in a standalone Sidebar Page across reload", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    { label: "standalone-page-files", scenarioId: PAGE_RELOCATION_SCENARIO_ID },
    async ({ application, page, facts }) => {
      const { standalonePageId } = requirePageRelocationScenarioFacts(facts);
      const space = page
        .getByRole("navigation", { name: "App navigation", exact: true })
        .getByRole("button", { name: "Space", exact: true });
      const content = page
        .getByRole("navigation", { name: "Space", exact: true })
        .getByRole("list", { name: "Content", exact: true });
      const sidebarPage = content.getByRole("listitem").filter({ hasText: "Sidebar Page to move" });
      const openSidebarPage = async () => {
        await space.click();
        await expect(content).toBeVisible();
        if (!(await sidebarPage.isVisible())) {
          await content.getByRole("button", { name: "Show more", exact: true }).click();
        }
        await sidebarPage.click();
      };
      await openSidebarPage();
      const stage = page.locator(`[data-page-stage-page-id="${standalonePageId}"]:visible`);
      const editor = stage.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      await expect(editor).toBeVisible();
      await editor.click();
      await writeTestClipboardImage(application, PNG_DATA_URL);
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+v`);

      const imageBlock = stage.locator('[data-content-type="image"][data-url^="nodex://files/"]');
      await expect(imageBlock.locator("img")).toBeVisible();
      await expect
        .poll(async () => (await readPageFiles(page, standalonePageId)).placed_total)
        .toBe(1);
      const source = await imageBlock.getAttribute("data-url");
      const inventory = await readPageFiles(page, standalonePageId);
      expect(inventory.unplaced_total).toBe(0);
      expect(inventory.total).toBe(1);

      await page.reload();
      await openSidebarPage();
      await expect(imageBlock).toHaveAttribute("data-url", source!);
      await expect(imageBlock.locator("img")).toBeVisible();
      await expect
        .poll(() =>
          imageBlock
            .locator("img")
            .evaluate(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
            ),
        )
        .toBe(true);
      await page.screenshot({ path: test.info().outputPath("standalone-page-image.png") });
    },
  );
});
