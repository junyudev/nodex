import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { AGENT_CLI_SCENARIO_ID } from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import { invokeIpc } from "./support/agent-smoke-harness";
import {
  CLAUDE_MIGRATION_TITLE,
  CLAUDE_RELEASE_TITLE,
  OLDEST_CODEX_TITLE,
  conversationImportHistoryCounts,
  writeConversationImportHistory,
} from "./support/conversation-import-history";
import { openWorkbenchSettings } from "./support/workbench-settings";

test("searches a whole history and imports a selection made across searches", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "conversation-import-browse",
      scenarioId: AGENT_CLI_SCENARIO_ID,
      isolateHostDirectories: true,
      environment: {
        NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: path.resolve("."),
        NODEX_LOG_FILE: "1",
      },
      onFailure: async ({ readRuntimeLogs }) => {
        await testInfo.attach("conversation-import-runtime.log", {
          body: await readRuntimeLogs(),
          contentType: "text/plain",
        });
      },
    },
    async ({ harness, page }) => {
      const claudeHome = path.join(harness.profile.runRoot, "native-claude");
      mkdirSync(claudeHome, { recursive: true });
      writeConversationImportHistory({
        codexHome: harness.profile.codexHome,
        claudeHome,
        root: path.join(harness.profile.runRoot, "home"),
        nowMs: Date.now(),
      });
      const executable = path.join(harness.profile.runRoot, "claude");
      const peer = pathToFileURL(
        path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
      ).href;
      writeFileSync(executable, `#!${process.execPath}\nimport(${JSON.stringify(peer)});\n`, {
        mode: 0o755,
      });
      await invokeIpc(page, "settings:claude-agents:update", {
        instances: [
          {
            id: "native-work",
            displayName: "Work",
            binaryPath: executable,
            configDirectory: claudeHome,
            enabled: true,
            environment: [],
          },
        ],
      });

      await openWorkbenchSettings(page);
      await page.getByRole("link", { name: "Conversations", exact: true }).click();

      const total = conversationImportHistoryCounts.codex + conversationImportHistoryCounts.claude;
      const selection = page.getByRole("group", { name: "Import selection", exact: true });
      const status = selection.getByRole("status");
      const search = page.getByRole("textbox", {
        name: "Search conversations or paste a link or ID",
        exact: true,
      });
      const row = (title: string) => page.getByRole("group", { name: title, exact: true });

      // The whole history arrives without being asked for, past every source's first pages.
      await expect(status).toHaveText(`${total} conversations`, { timeout: 60_000 });
      await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("conversation-import-list.png") });

      await search.fill("BILLING ledger");
      await expect(row(OLDEST_CODEX_TITLE)).toBeVisible();
      await expect(status).toHaveText(`1 of ${total} conversations`);
      await page.screenshot({ path: testInfo.outputPath("conversation-import-search.png") });

      // A selection outlives the search that found it.
      await search.fill("harbor release");
      await row(CLAUDE_RELEASE_TITLE).getByRole("checkbox").click();
      await search.fill("迁移计划");
      await row(CLAUDE_MIGRATION_TITLE).getByRole("checkbox").click();
      await expect(status).toHaveText("2 selected · 1 not shown");
      await page.screenshot({ path: testInfo.outputPath("conversation-import-selection.png") });

      await selection.getByRole("button", { name: /^2 selected/u }).click();
      await expect(search).toHaveValue("");
      await expect(row(CLAUDE_RELEASE_TITLE)).toBeVisible();
      await expect(row(CLAUDE_MIGRATION_TITLE)).toBeVisible();
      await expect(status).toHaveText("2 selected");

      await selection.getByRole("button", { name: "Import 2", exact: true }).click();
      await expect(status).toHaveText("Imported 2 conversations", { timeout: 60_000 });

      // Filters read the list as it now stands.
      await page.getByRole("button", { name: "Filter by status", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Imported/u }).click();
      await expect(row(CLAUDE_RELEASE_TITLE).getByRole("button", { name: "Open" })).toBeVisible();
      await expect(status).toHaveText(`2 of ${total} conversations`);

      await page.getByRole("button", { name: "Filter by status", exact: true }).click();
      await page.getByRole("menuitem", { name: /^All statuses/u }).click();
      await page.getByRole("button", { name: "Filter by folder", exact: true }).click();
      await expect(page.getByRole("option", { name: /^~\/repo\/atlas\s*\d+$/u })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("conversation-import-folders.png") });
      await page.getByRole("option", { name: /^~\/repo\/harbor\s*\d+$/u }).click();
      await expect(page.getByRole("button", { name: "Filter by folder", exact: true })).toHaveText(
        "harbor",
      );
      await page.getByRole("button", { name: "Filter by agent", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Claude Code/u }).click();
      await page.screenshot({ path: testInfo.outputPath("conversation-import-filtered.png") });
    },
  );
});
