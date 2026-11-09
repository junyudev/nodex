import path from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { invokeIpc } from "./support/editor-scenario";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";
import {
  NODEX_COORDINATOR_SCENARIO_ID,
  requireNodexCoordinatorFacts,
} from "../../scripts/scenarios/scenarios/nodex-coordinator";

test("shows Nodex's Inbox, managed work and the work graph", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const runtimeRoot = testInfo.outputPath("native-peer");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(runtimeRoot, "plan.json"), "{}");
  prepareScenarioCodexAppServerRuntimeSync(
    runtimeRoot,
    path.resolve("scripts/scenarios/runtime/cross-provider-peer.mjs"),
  );
  await withElectronScenario(
    {
      label: "nodex-coordinator",
      scenarioId: NODEX_COORDINATOR_SCENARIO_ID,
      seedThrough: "core",
      cwd: runtimeRoot,
      prepareAgentRuntime: false,
      environment: {
        NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: runtimeRoot,
        NODEX_TEST_CROSS_PROVIDER_HOME: runtimeRoot,
      },
        await page?.screenshot({ path: testInfo.outputPath("failure.png") });
        await writeFile(testInfo.outputPath("runtime.log"), await readRuntimeLogs());
      },
    },
    async ({ page, manifest, facts }) => {
      if (!manifest) throw new Error("Missing Coordinator manifest");
      page.setDefaultTimeout(15_000);
      const observed = requireNodexCoordinatorFacts(facts);
      expect(observed.planSteps).toHaveLength(3);
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      const providers = await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
      await writeFile(testInfo.outputPath("providers.json"), JSON.stringify(providers, null, 2));
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      const screenshot = async (name: string) => {
        await page.mouse.move(8, 8);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        const output = testInfo.outputPath(name + ".png");
        await page.screenshot({ path: output, animations: "disabled" });
      };
      const openLibraryInbox = async () => {
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        await expect(page.locator('[data-inbox-scope="library"]:visible')).toBeVisible();
      };
      const message = (key: string) =>
        page.locator('[data-inbox-page-id="' + manifest.pageIdsByKey[key] + '"]:visible');
      await openLibraryInbox();
      const plan = message("planRequest");
      await expect(plan.getByRole("button", { name: "Start 3 cards", exact: true })).toBeVisible();
      await expect(plan.getByTestId("inbox-plan-steps").locator("li")).toHaveCount(3);
      await expect(plan.getByText(/Loading…|Checking models…/u)).toHaveCount(0);
      await expect(result.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
      await screenshot("01-library-inbox");
      await page
        .getByRole("tablist", { name: "Inbox view" })
        .getByRole("tab", { name: /^Inbox/u })
        .click();
      await expect(plan.getByRole("button", { name: "Start 3 cards", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Inbox settings", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "Inbox settings" });
      await expect(settings.getByRole("heading", { name: "Nodex", exact: true })).toBeVisible();
      await expect(
      ).toBeVisible();
      await screenshot("05-inbox-settings");
      await page.keyboard.press("Escape");
      await result.getByRole("button", { name: "Reply", exact: true }).click();
      await expect(page.getByTestId("inbox-composer-reply")).toContainText("Replying to");
      await expect(page.getByRole("textbox", { name: "Message your Inbox" })).toHaveAttribute(
        "placeholder",
      );
      await screenshot("06-reply-to-result");
      await page.getByRole("textbox", { name: "Message your Inbox" }).press("Escape");
      await expect(page.getByTestId("inbox-composer-reply")).toHaveCount(0);

      await page
        .locator('[data-app-action-sidebar-project-label="Nodex"]')
        .getByRole("button", { name: "Open Nodex", exact: true })
        .click();
      await openProjectBoard(page);
      const card = (key: string) =>
        page.locator('[data-board-uuid-v7="' + manifest.pageIdsByKey[key] + '"]:visible');
      await expect(card("ask").getByRole("button", { name: "Start", exact: true })).toBeVisible();
      await expect(card("done")).toHaveCount(1);
      await expect(
        card("chainStart").locator('[data-page-chat-activity-control="true"]'),
      ).toHaveAttribute("aria-label", /1 working chat/u);
      await expect(
        card("needsYou").locator('[data-page-chat-activity-control="true"]'),
      ).toHaveAttribute("aria-label", /1 awaiting input/u);
      await screenshot("03-project-board");
      await card("done").scrollIntoViewIfNeeded();
      await screenshot("03-project-board-done");
      await card("ask").scrollIntoViewIfNeeded();
      await page
        .getByRole("button", { name: "Open Page Polish empty search results", exact: true })
        .click();
      const stage = page.locator(
        '[data-page-stage-page-id="' +
          manifest.pageIdsByKey.ask +
          '"][data-page-stage-surface="true"]:visible',
      );
      await expect(stage.getByRole("button", { name: "Start", exact: true })).toBeVisible();
      await screenshot("04-page-agent-work");
    },
  );
});
