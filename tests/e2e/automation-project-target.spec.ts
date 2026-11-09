import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID } from "../../scripts/scenarios/scenarios/sidebar-custom-sections";
import type {
  ProjectSessionSummaryWindow,
  AutomationDecisionsResponse,
  AutomationRunsInboxResponse,
} from "../../src/shared/types";

test("selects one Automation Project and records a Dry run without starting work", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "automation-project-target",
      scenarioId: SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
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
    async ({ page, application }) => {
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
      });
      const automationId = await page.evaluate(async () => {
        const api = (
          window as unknown as {
            api: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
          }
        ).api;
        const result = (await api.invoke("automations:create", {
          kind: "cron",
          name: "Project target review",
          prompt: "Review this workspace",
          rrule: "FREQ=YEARLY",
          projectId: null,
          cwds: [],
          executionEnvironment: "local",
        })) as { item?: { id: string }; error?: string };
        if (!result.item?.id) throw new Error(JSON.stringify(result));
        return result.item.id;
      });
      await page.getByRole("button", { name: "Automations", exact: true }).click();
      const row = page
        .locator(`[data-automation-id="${automationId}"]`)
        .getByRole("button", { name: /^Project target review/ });
      await row.hover();
      await row.getByRole("button", { name: "More automation actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit automation" });
      await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
      const project = dialog.getByRole("button", { name: "Project", exact: true });
      await expect(project).toHaveText("No project");
      await project.click();
      await page.getByRole("menuitem", { name: /Section Project/ }).click();
      await expect(project).toHaveText("Section Project");
      await page.getByRole("menuitem", { name: /Inbox Project/ }).click();
      await expect(project).toHaveText("Inbox Project");
      await expect(dialog.getByRole("button", { name: "Workspace", exact: true })).toHaveText(
        "Local",
      );
      await testInfo.attach("project-selection", {
        body: await page.screenshot({ path: testInfo.outputPath("project-selection.png") }),
        contentType: "image/png",
      });
      await page.getByRole("menuitem", { name: "No project", exact: true }).click();
      await expect(project).toHaveText("No project");
      await expect(dialog.getByRole("button", { name: "Workspace", exact: true })).toHaveCount(0);
      await dialog.getByRole("button", { name: "Mode", exact: true }).click();
      await page.getByRole("menuitem", { name: "Dry run", exact: true }).click();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden();
      await row.click();

      const readObservationState = () =>
        page.evaluate(async (id) => {
          const api = (
            window as unknown as {
              api: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
            }
          ).api;
          const decisions = (await api.invoke("automations:decisions:list", {
            automationId: id,
          })) as AutomationDecisionsResponse;
          const runs = (await api.invoke(
            "automations:runs:inbox-items",
          )) as AutomationRunsInboxResponse;
          const chats = (await api.invoke("workspace:tasks:list", null, {
            first: 200,
            includeArchived: true,
          })) as ProjectSessionSummaryWindow;
          return {
            decisions: decisions.items,
            runIds: runs.items.filter((run) => run.automationId === id).map((run) => run.id),
            chatIds: chats.items.map((chat) => chat.id).sort(),
            hasMoreChats: chats.hasMore,
          };
        }, automationId);
      const before = await readObservationState();
      expect(before.decisions).toEqual([]);
      expect(before.runIds).toEqual([]);
      expect(before.hasMoreChats).toBe(false);

      await row.hover();
      await row.getByRole("button", { name: "More automation actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Run now", exact: true }).click();
      const decisions = page.getByRole("region", { name: "Recent decisions", exact: true });
      await expect(decisions.getByText("Manual run", { exact: true })).toBeVisible();
      await expect(decisions.getByText("Dry run", { exact: true })).toBeVisible();
      const after = await readObservationState();
      expect(after.decisions).toEqual([
        expect.objectContaining({
          automationId,
          status: "completed",
          mode: "dry_run",
          reason: "Manual run",
          pageId: null,
          sessionId: null,
        }),
      ]);
      expect(after.runIds).toEqual(before.runIds);
      expect(after.chatIds).toEqual(before.chatIds);
      await testInfo.attach("observed-decision", {
        body: await page.screenshot({ path: testInfo.outputPath("observed-decision.png") }),
        contentType: "image/png",
      });

      await page
        .getByRole("navigation", { name: "App navigation", exact: true })
        .getByRole("button", { name: "Home", exact: true })
        .click();
      await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
      const inbox = page.locator('[data-inbox-scope="library"]:visible');
      await expect(inbox).toBeVisible();
      await inbox
        .getByRole("tablist", { name: "Inbox view" })
        .getByRole("tab", { name: "Activity", exact: true })
        .click();
      const activity = inbox.getByTestId("inbox-activity");
      await activity.getByRole("button", { name: "Nodex & automations", exact: true }).click();
      await expect(
        activity.getByText("Would have started “Project target review”", { exact: true }),
      ).toBeVisible();
      await testInfo.attach("observed-activity", {
        body: await page.screenshot({ path: testInfo.outputPath("observed-activity.png") }),
        contentType: "image/png",
      });
      await activity.getByRole("button", { name: "Project target review", exact: true }).click();
      await expect(page.getByTestId("automations-route")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Project target review settings", exact: true }),
      ).toBeVisible();
      await expect(decisions.getByText("Dry run", { exact: true })).toBeVisible();
    },
  );
});
