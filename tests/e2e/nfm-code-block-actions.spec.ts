import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import type { ScenarioManifest } from "../../scripts/scenarios/contracts";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  NFM_CODE_BLOCK_ACTIONS_PAGE_KEY,
  NFM_CODE_BLOCK_ACTIONS_SCENARIO_ID,
  NFM_CODE_BLOCK_ACTIONS_SOURCE,
} from "../../scripts/scenarios/scenarios/nfm-code-block-actions";
import { openBoardPageFromCard } from "./support/open-board-page";

const primaryShortcut = (key: string): string =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

interface CodeBlockScene {
  readonly actionBar: Locator;
  readonly blockId: string;
  readonly surface: Locator;
}

async function focusCodeBlockScene(
  application: ElectronApplication,
  page: Page,
  manifest: ScenarioManifest,
): Promise<CodeBlockScene> {
  const pageId = manifest.pageIdsByKey[NFM_CODE_BLOCK_ACTIONS_PAGE_KEY];
  if (!pageId) throw new Error("nfm-code-block-actions has no Page fixture");
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
  });
  await page
    .getByRole("button", { name: "Open Code Block Actions", exact: true })
    .evaluate((element) => (element as HTMLElement).click());
  await page.getByRole("tab", { name: "Project Home" }).waitFor();
  const card = page.locator(`[data-board-uuid-v7="${pageId}"]`);
  await openBoardPageFromCard({ card, page, tabName: "Exercise Code Block actions" });

  const editor = page.locator(`[data-page-stage-page-id="${pageId}"]:visible .nfm-editor`);
  const initialSurface = editor
    .locator('[data-nfm-code-block-surface][data-language="typescript"]')
    .first();
  await expect(initialSurface).toBeVisible({ timeout: 15_000 });
  const blockId = await initialSurface.getAttribute("data-block-id");
  if (!blockId) throw new Error("Code Block surface has no stable block ID");
  const surface = editor.locator(`[data-nfm-code-block-surface][data-block-id="${blockId}"]`);
  await surface.hover();
  const actionBar = page.getByRole("toolbar", { name: "Code block action bar" });
  await expect(actionBar).toBeVisible();
  return { actionBar, blockId, surface };
}

test("NFM Code Block language and Copy work through the packaged Electron surface", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    { label: "nfm-code-block-language-copy", scenarioId: NFM_CODE_BLOCK_ACTIONS_SCENARIO_ID },
    async ({ application, page, manifest }) => {
      if (!manifest) throw new Error("nfm-code-block-actions did not materialize");
      const { actionBar, surface } = await focusCodeBlockScene(application, page, manifest);
      const languageTrigger = actionBar.getByRole("button", {
        name: "Open language dropdown",
      });

      await languageTrigger.click();
      const languageSearch = page.getByRole("combobox", { name: "Search code languages" });
      await expect(languageSearch).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(languageTrigger).toBeFocused();
      await languageTrigger.click();
      await languageSearch.fill("python");
      await page.getByRole("option", { name: "Python" }).click();
      await expect(surface).toHaveAttribute("data-language", "python");

      await surface.hover();
      await actionBar.getByRole("button", { name: "Copy code to clipboard" }).click();
      await expect
        .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(NFM_CODE_BLOCK_ACTIONS_SOURCE);
    },
  );
});

test("NFM Code Block Wrap stays local while Format remains one undo step", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    { label: "nfm-code-block-wrap-format", scenarioId: NFM_CODE_BLOCK_ACTIONS_SCENARIO_ID },
    async ({ application, page, manifest }) => {
      if (!manifest) throw new Error("nfm-code-block-actions did not materialize");
      const { actionBar, blockId, surface } = await focusCodeBlockScene(
        application,
        page,
        manifest,
      );

      await actionBar.getByRole("button", { name: "Open block actions menu" }).click();
      await page.getByRole("option", { name: "Wrap code" }).click();
      await expect(surface).toHaveAttribute("data-wrapped", "true");
      await expect
        .poll(() => page.evaluate((key) => localStorage.getItem(key), `code-wrap-${blockId}`))
        .toBe("true");

      await page.getByRole("option", { name: "Format code" }).click();
      await expect(surface.locator("code")).toContainText("const answer: number = 42;");
      await surface.locator("code").click();
      await page.keyboard.press(primaryShortcut("z"));
      await expect(surface.locator("code")).toContainText(NFM_CODE_BLOCK_ACTIONS_SOURCE);
      await expect(surface).toHaveAttribute("data-wrapped", "true");
    },
  );
});
