import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID } from "../../scripts/scenarios/scenarios/sidebar-custom-sections";

test("selects one Automation Project even when Projects share a folder", async ({}, testInfo) => {
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
      await page.evaluate(async () => {
        const api = (
          window as unknown as {
            api: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
          }
        ).api;
        const result = (await api.invoke("codex:scheduled-automations:create", {
          kind: "cron",
          name: "Project target review",
          prompt: "Review this workspace",
          rrule: "FREQ=YEARLY",
          projectId: null,
          cwds: [],
          executionEnvironment: "local",
        })) as { item?: { id: string }; error?: string };
        if (!result.item?.id) throw new Error(JSON.stringify(result));
      });
      await page.getByRole("button", { name: "Scheduled", exact: true }).click();
      await page.getByTestId("automation-list-row-project-target-review").click();
      const project = page.getByRole("button", { name: "Project", exact: true });
      await expect(project).toHaveText("No project");
      await project.click();
      await page.getByRole("menuitem", { name: /Section Project/ }).click();
      await expect(project).toHaveText("Section Project");
      await page.getByRole("menuitem", { name: /Inbox Project/ }).click();
      await expect(project).toHaveText("Inbox Project");
      await testInfo.attach("project-selection", {
        body: await page.screenshot({ path: testInfo.outputPath("project-selection.png") }),
        contentType: "image/png",
      });
      await page.getByRole("menuitem", { name: "No project", exact: true }).click();
      await expect(project).toHaveText("No project");
      await expect(
        page.getByRole("button", { name: "Execution environment", exact: true }),
      ).toHaveText("Local");
    },
  );
});
