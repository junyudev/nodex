import { expect, test } from "@playwright/test";
import { cp } from "node:fs/promises";
import path from "node:path";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";

test("adds a plugin from a folder, limits it to a Project and updates it", async ({}, testInfo) => {
  await withElectronScenario(
    {
      label: "plugins-from-folder",
      scenarioId: null,
      // Folder installation exercises the pinned Codex marketplace and plugin APIs.
      prepareAgentRuntime: false,
      isolateHostDirectories: true,
      environment: { NODEX_LOG_FILE: "1" },
      onFailure: async ({ readRuntimeLogs }) => {
        await testInfo.attach("runtime", {
          body: await readRuntimeLogs(),
          contentType: "text/plain",
        });
      },
    },
    async ({ application, page, profile, seed }) => {
      const folder = path.join(profile.runRoot, "field-notes");
      await cp(path.resolve("tests/e2e/fixtures/plugins/field-notes"), folder, {
        recursive: true,
      });
      await seed.createProject({ name: "Plugin Alpha" });
      await seed.createProject({ name: "Plugin Beta" });

      // Playwright answers the system folder picker; review and installation go through Main.
      await application.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [directory],
          bookmarks: [],
        });
      }, folder);
      const capture = (name: string) =>
        page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

      await page
        .getByRole("navigation", { name: "App navigation" })
        .getByRole("button", { name: "Plugins", exact: true })
        .click();
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("menuitem", { name: "Plugin from folder…" }).click();

      const review = page.getByRole("dialog", { name: "Add plugin from folder" });
      await expect(review.getByText("Field Notes", { exact: true })).toBeVisible();
      await expect(review.getByText("summarize-notes")).toBeVisible();
      await expect(review.getByText("node ./server.mjs")).toBeVisible();
      await expect(review.getByText("Only in Codex: notes-cloud (needs sign-in)")).toBeVisible();
      await capture("1-review");
      await review.getByRole("button", { name: "Install", exact: true }).click();
      await page.getByText("Field Notes plugin installed", { exact: true }).waitFor();
      await expect(page.getByRole("dialog")).toBeHidden();
      await capture("2-installed");

      // Installing opens the plugin's page.
      const installation = page.locator("#plugin-installation");
      await expect(installation).toBeVisible();
      await expect(installation.getByText("All projects")).toBeVisible();
      await expect(installation.getByText("Codex, Claude Code and ACP agents")).toBeVisible();
      await expect(
        installation.getByText("Servers that need a sign-in work only in Codex"),
      ).toBeVisible();
      await expect(page.getByText("Codex only · needs sign-in")).toBeVisible();
      await capture("3-plugin-page");

      await installation.getByRole("button", { name: "All projects" }).click();
      await page.getByRole("menuitem", { name: "Plugin Alpha" }).click();
      await page.keyboard.press("Escape");
      await expect(installation.getByRole("button", { name: "Plugin Alpha" })).toBeVisible();
      await capture("4-scope");

      const pluginActions = page
        .locator("header")
        .filter({ has: page.getByRole("heading", { name: /^Field Notes/u, level: 1 }) })
        .getByRole("button", { name: "More actions", exact: true });
      await pluginActions.click();
      await page.getByRole("menuitem", { name: "Update from folder" }).click();
      const update = page.getByRole("alert").filter({ hasNotText: "Field Notes plugin installed" });
      await update.waitFor();
      expect(await update.innerText()).toBe("Field Notes updated from its folder");

      await pluginActions.click();
      await page.getByRole("menuitem", { name: "Uninstall" }).click();
      await expect(installation).toBeHidden();
    },
  );
});
