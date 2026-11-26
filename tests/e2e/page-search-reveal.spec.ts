import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../scripts/scenarios/scenarios/board-dense";
import { focusBoardDenseUi } from "../../scripts/scenarios/scenarios/board-dense-ui";
import {
  LIBRARY_FILES_PAGE_A_KEY,
  LIBRARY_FILES_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/library-files";
import { openLibraryFilesPage } from "../../scripts/scenarios/scenarios/library-files-ui";
import type { LibraryNavigationChangedEvent } from "../../src/shared/library-events";
import type { PageSearchMetadataSnapshot } from "../../src/shared/types";
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
      const find = page.getByRole("textbox", { name: "Search Page" });
      const activeMark = ".nfm-search-match-active";

      const openHit = async (shortcut: string) => {
        await page.keyboard.press(primaryShortcut(shortcut));
        const palette = page.getByRole("dialog", { name: "Command palette" });
        const search = palette.getByRole("combobox", { name: "Command palette search" });
        await search.fill("迁移 方案");
        const result = palette.getByRole("option", { name: new RegExp(title, "u") });
        await expect(result).toBeVisible();
        if (shortcut === "K") {
          const top = palette.getByRole("group", { name: "Top result" });
          await expect(top.getByRole("option", { name: new RegExp(title, "u") })).toBeVisible();
          await expect(result).toHaveCount(1);
        }
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

test("refreshes Page search metadata after each title edit", async () => {
  await withElectronScenario(
    { label: "page-search-rename", scenarioId: LIBRARY_FILES_SCENARIO_ID },
    async ({ page, manifest }) => {
      const pageId = manifest?.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY];
      if (!manifest || !pageId) throw new Error("library/files Page A did not materialize");
      const initialTitle = "Shared image A";
      await openLibraryFilesPage(page, manifest, LIBRARY_FILES_PAGE_A_KEY, initialTitle);

      const subscription = await page.evaluateHandle((pageId) => {
        const api = window.api!;
        const readTitle = async () => {
          const snapshot = (await api.invoke("pages:search-metadata", undefined, [
            pageId,
          ])) as PageSearchMetadataSnapshot;
          return snapshot.documents.find((document) => document.pageId === pageId)?.title;
        };
        let title = readTitle();
        const unsubscribe = api.on("library-navigation-changed", (payload) => {
          const event = payload as LibraryNavigationChangedEvent;
          if (event.changeKind === "content" && event.affectedPageIds.includes(pageId)) {
            title = readTitle();
          }
        });
        return { read: () => title, unsubscribe };
      }, pageId);

      try {
        const stage = page.locator(`[data-page-stage-page-id="${pageId}"]:visible`);
        const title = stage.getByRole("textbox", { name: "Page title", exact: true });
        const readSubscribedTitle = () => subscription.evaluate(({ read }) => read());
        await expect.poll(readSubscribedTitle).toBe(initialTitle);

        for (const nextTitle of ["Search metadata probe", "Search metadata probe two"]) {
          await title.fill(nextTitle);
          await title.press("Tab");
          await expect.poll(readSubscribedTitle).toBe(nextTitle);
        }
      } finally {
        await subscription.evaluate(({ unsubscribe }) => unsubscribe());
        await subscription.dispose();
      }
    },
  );
});
