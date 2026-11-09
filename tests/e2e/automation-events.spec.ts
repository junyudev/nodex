import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { AUTOMATION_EVENTS_SCENARIO_ID } from "../../scripts/scenarios/scenarios/automation-events";
import { assessSeededAutomationCheck } from "../../scripts/scenarios/seed/automation-event";
import { CoreClient } from "../../src/main/core-client/core-client";

test("Dry run explains a check failure and Ask first proposes the next failure", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const screenshots =
    process.env.NODEX_AUTOMATION_SCREENSHOTS ?? testInfo.outputPath("screenshots");
  await withElectronScenario(
    {
      label: "automation-events",
      scenarioId: AUTOMATION_EVENTS_SCENARIO_ID,
      seedThrough: "core",
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("runtime", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        if (page)
          await testInfo.attach("failure", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
      },
    },
    async ({ page, application, profile, manifest }) => {
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      const client = await CoreClient.connect({
        nodexHome: profile.nodexHome,
        clientKind: "electron_host",
        buildId: "automation-events-e2e",
      });
      await client.workspaceApply({
        operationId: crypto.randomUUID(),
        intent: { kind: "pause_work", scope: { kind: "space" } },
      });
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
      });
      const automationId = manifest!.entityIdsByKey!.eventAutomation!;
      const activity = await client.workspaceRead({
        kind: "activity_window",
        scope: { kind: "all" },
        filter: "decisions",
        window: { first: 100, after: null },
      });
      if (activity.value.kind !== "activity_window") throw new Error("Missing Activity");
      expect(
        activity.value.rows.items.some(
          (row) => row.description === "Would have started “Investigate failed checks”",
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "Automations", exact: true }).click();
      await page
        .locator(`[data-automation-id="${automationId}"]`)
        .getByRole("button", { name: /^Investigate failed checks/ })
        .click();
      await expect(
        page.getByText("The seeded CI check failed in this Project's repository.", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Matched", { exact: true })).toBeVisible();
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({
        path: `${screenshots}/01-observe-decision.png`,
        animations: "disabled",
      });
      const binding = await client.workspaceRead({ kind: "read_coordinator" });
      if (binding.value.kind !== "read_coordinator" || !binding.value.session_id)
        throw new Error("Missing Coordinator");
      await assessSeededAutomationCheck(client, binding.value.session_id, 2);
      await expect(page.getByText("Matched", { exact: true })).toHaveCount(2);
      await page
        .getByRole("button", { name: "Investigate failed checks settings", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Edit automation" });
      await expect(dialog.getByRole("button", { name: "When", exact: true })).toHaveText(
        "Something happens on GitHub",
      );
      await expect(dialog.getByRole("checkbox", { name: "Check failed" })).toBeChecked();
      await page.screenshot({ path: `${screenshots}/02-event-editor.png`, animations: "disabled" });
      await dialog.getByRole("button", { name: "Mode", exact: true }).click();
      await page.getByRole("menuitem", { name: "Ask first", exact: true }).click();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await assessSeededAutomationCheck(client, binding.value.session_id, 3);
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await page
        .locator('[data-app-action-sidebar-project-label="Nodex"]')
        .getByRole("button", { name: "Open Nodex", exact: true })
        .click();
      await expect(page.locator('[data-inbox-scope="project"]:visible')).toBeVisible();
      await expect(
        page
          .locator('[data-inbox-scope="project"]:visible')
          .getByText("Investigate the failing typecheck and propose a fix.", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: `${screenshots}/03-ask-proposal.png`, animations: "disabled" });
      const decisions = await client.automationRead({
        kind: "automation_decisions",
        automation_id: automationId,
        window: { first: 10 },
      });
      if (decisions.value.kind !== "automation_decisions") throw new Error("Missing decisions");
      expect(decisions.value.window.items.map((d) => d.mode)).toEqual([
        "ask_first",
        "dry_run",
        "dry_run",
      ]);
      expect(decisions.value.window.items[0]?.status).toBe("held");
    },
  );
});
