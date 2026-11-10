import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  RELEASE_PARAGRAPH,
  RELEASE_SKILL,
  RELEASE_SKILL_PATH,
  SKILLS_PAGES_PROJECT,
  SKILLS_PAGES_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/skills-pages";
import { invokeIpc } from "./support/editor-scenario";

test("opens and edits skills in their Project folders", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: SKILLS_PAGES_SCENARIO_ID,
      scenarioId: SKILLS_PAGES_SCENARIO_ID,
      isolateHostDirectories: true,
      onFailure: async ({ readRuntimeLogs }) => {
        await testInfo.attach("runtime", {
          body: await readRuntimeLogs(),
          contentType: "text/plain",
        });
      },
    },
    async ({ page, profile }) => {
      const navigation = page.getByRole("navigation", { name: "App navigation" });
      const customize = page.getByRole("navigation", { name: "Customize" });
      const openSkillsList = () =>
        customize.getByRole("button", { name: "Skills", exact: true }).click();
      // Folder discovery needs a Claude instance, but the test never starts a conversation.
      await invokeIpc(page, "settings:claude-agents:update", {
        instances: [
          {
            id: "claude-default",
            displayName: "Claude Code",
            binaryPath: path.join(profile.runRoot, "unavailable-claude"),
            configDirectory: profile.claudeConfigHome,
            enabled: true,
            environment: [],
            customModels: [],
          },
        ],
      });
      const projectRoot = path.join(profile.projectsDirectory, "release-engineering");
      const skillPath = path.join(projectRoot, RELEASE_SKILL_PATH);
      await page.getByRole("button", { name: `Open ${SKILLS_PAGES_PROJECT}`, exact: true }).click();
      await navigation.getByRole("button", { name: "Plugins", exact: true }).click();
      await openSkillsList();
      await expect(page.getByText(/\.agents\/skills$/u).first()).toBeVisible();
      await expect(page.getByText(/\.claude\/skills$/u).first()).toBeVisible();
      await expect(
        page.getByRole("img", { name: "Codex reads this folder" }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("img", { name: "Claude reads this folder" }).first(),
      ).toBeVisible();

      await page.getByRole("button", { name: /status-template/u }).click();
      await expect(page.getByText(/This skill is edited as source/u)).toBeVisible();
      await expect(page.getByLabel("Source of status-template")).toBeVisible();
      await openSkillsList();

      await page.getByRole("button", { name: /release-checklist/u }).click();
      const title = page.getByRole("textbox", { name: "Skill name" });
      await expect(title).toHaveValue("release-checklist");
      const updatedParagraph = "Review the signed changes since the last release tag.";
      const paragraph = page.getByText(RELEASE_PARAGRAPH, { exact: true });
      await paragraph.click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+Shift+ArrowRight" : "Shift+End",
      );
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString()))
        .toBe(RELEASE_PARAGRAPH);
      await page.keyboard.insertText(updatedParagraph);
      const updated = RELEASE_SKILL.replace(RELEASE_PARAGRAPH, updatedParagraph);
      await expect.poll(() => readFile(skillPath, "utf8")).toBe(updated);

      const externalParagraph = "Review the release notes against the signed tag.";
      await writeFile(skillPath, updated.replace(updatedParagraph, externalParagraph));
      await expect(page.getByText(externalParagraph, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Source", exact: true }).click();
      await expect(page.getByRole("button", { name: "Source", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByLabel("Source of release-checklist")).toBeVisible();

      await openSkillsList();
      await page
        .getByRole("button", { name: /New skill in .*release-engineering.*\.agents\/skills$/u })
        .click();
      await expect(title).toBeFocused();
      await title.fill("audit-release");
      await title.press("Tab");
      await expect(title).toHaveValue("audit-release");
      await expect
        .poll(() =>
          readFile(path.join(projectRoot, ".agents/skills/audit-release/SKILL.md"), "utf8").catch(
            () => "",
          ),
        )
        .toMatch(/^name: "?audit-release"?$/mu);

      await navigation.getByRole("button", { name: "Home", exact: true }).click();
      await page
        .getByRole("button", { name: `Start new chat in ${SKILLS_PAGES_PROJECT}`, exact: true })
        .click();
      const scene = page.locator('[data-workbench-scene-owner^="session:"]:visible');
      await expect(scene).toBeVisible();
      const openSkillResult = async (name: string) => {
        await page
          .getByRole("navigation", { name: "Home", exact: true })
          .getByRole("button", { name: "Search", exact: true })
          .click();
        const palette = page.getByRole("dialog", { name: "Command palette" });
        await palette.getByRole("tab", { name: "All", exact: true }).click();
        await palette.getByRole("combobox").fill(name);
        await palette
          .getByRole("group", { name: "Skills", exact: true })
          .getByRole("option", { name: new RegExp(`^${name}`, "u") })
          .click();
      };
      await openSkillResult("audit-release");
      const tab = page.getByRole("tab", { name: "audit-release", exact: true });
      await expect(tab).toBeVisible();
      const tabId = await tab.evaluate((element) =>
        element.closest("[data-panel-tab-id]")?.getAttribute("data-panel-tab-id"),
      );
      expect(tabId).toBeTruthy();
      await openSkillResult("incident-summary");
      await expect(title).toHaveValue("incident-summary");
      await openSkillResult("audit-release");
      await expect(tab).toHaveCount(1);
      await expect(title).toHaveValue("audit-release");
      await title.fill("audit-signed-release");
      await title.press("Tab");
      const renamed = page.getByRole("tab", { name: "audit-signed-release", exact: true });
      await expect(renamed).toBeVisible();
      expect(
        await renamed.evaluate((element) =>
          element.closest("[data-panel-tab-id]")?.getAttribute("data-panel-tab-id"),
        ),
      ).toBe(tabId);
    },
  );
});
