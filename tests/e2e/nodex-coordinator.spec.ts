import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { seedCoordinatorNativeExecution } from "../../scripts/scenarios/runtime/coordinator-native-seed";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
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
      onFailure: async ({ page, manifest, readRuntimeLogs }) => {
        await page?.screenshot({ path: testInfo.outputPath("failure.png") });
        if (page && manifest)
          await writeFile(
            testInfo.outputPath("turn-failure.json"),
            JSON.stringify(await invokeIpc(page, "work:turn", manifest.pageIdsByKey.ask!)),
          );
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
        const readyNotice = page
          .getByRole("alert")
          .filter({ hasText: "Global dictation is ready." });
        if (await readyNotice.count()) {
          await readyNotice
            .getByRole("button", { name: "Dismiss notification", exact: true })
            .click();
          await expect(readyNotice).toHaveCount(0);
        }
        await page.mouse.move(8, 8);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        const output = testInfo.outputPath(name + ".png");
        await page.screenshot({ path: output, animations: "disabled" });
        const directory =
          process.env.NODEX_INBOX_SCREENSHOTS ?? testInfo.outputPath("inbox-screenshots");
        await mkdir(directory, { recursive: true });
        await page.screenshot({
          path: path.join(directory, name + ".png"),
          animations: "disabled",
        });
      };
      const openLibraryInbox = async () => {
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        await expect(page.locator('[data-inbox-scope="library"]:visible')).toBeVisible();
      };
      const message = (key: string) =>
        page.locator('[data-inbox-page-id="' + manifest.pageIdsByKey[key] + '"]:visible');
      await openLibraryInbox();
      await page.getByTestId("inbox-stream").evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(
        message("handedBack").getByText("Update the keyboard shortcut guide.", { exact: true }),
      ).toBeVisible();
      await expect(
        message("handedBack").getByText("The keyboard navigation chat owns this change.", {
          exact: false,
        }),
      ).toBeVisible();
      await screenshot("00-intake-notes-answer");
      await screenshot("00-message-handed-back");
      await page.getByRole("button", { name: "Pause all Agent work", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Paused · Resume", exact: true }),
      ).toBeVisible();
      await screenshot("00-space-paused");
      await page.getByRole("button", { name: "Paused · Resume", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Pause all Agent work", exact: true }),
      ).toBeVisible();
      await seedCoordinatorNativeExecution(runtimeRoot, manifest);
      await invokeIpc(page, "codex:account:read");
      const opened = await invokeIpc(page, "project-sessions:record-opened", {
        operationId: createBoundedOperationId("e2e.observe-working-chat"),
        payload: { sessionId: manifest.entityIdsByKey!.chainStartSession! },
      });
      expect(opened.ok).toBe(true);
      await writeFile(
        testInfo.outputPath("native-connection.json"),
        JSON.stringify(await invokeIpc(page, "codex:connection:status")),
      );
      const plan = message("planRequest");
      await expect(plan.getByRole("button", { name: "Start 3 cards", exact: true })).toBeVisible();
      await expect(plan.getByTestId("inbox-plan-steps").locator("li")).toHaveCount(3);
      await expect(plan.getByText(/Loading…|Checking models…/u)).toHaveCount(0);
      const result = message("ready");
      await expect(result.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
      await expect(result.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
      await expect(
        message("needsYou").getByText("How long should completed sessions stay?", { exact: true }),
      ).toBeVisible();
      await expect(
        message("needsYou").getByRole("button", { name: "Keep 30 days", exact: true }),
      ).toBeVisible();
      await expect(
        message("failed").getByText("Failed · needs you", { exact: true }),
      ).toBeVisible();
      await expect(message("answer")).toBeVisible();
      await expect
        .poll(async () => {
          const rows = await page
            .getByTestId("inbox-stream")
            .locator("[data-inbox-page-id]")
            .evaluateAll((elements) =>
              elements
                .map((element) => {
                  const box = element.getBoundingClientRect();
                  return { top: box.top, bottom: box.bottom };
                })
                .sort((a, b) => a.top - b.top),
            );
          return rows.every((row, index) => index === 0 || row.top >= rows[index - 1]!.bottom - 1);
        })
        .toBe(true);
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
        "Reply to chat…",
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
      await expect(card("startedRequest")).toHaveCount(1);
      await expect(card("ready").getByText("Ready for your review", { exact: true })).toBeVisible();
      await expect(
        page
          .locator('[data-board-column-id="review"]')
          .locator('[data-board-uuid-v7="' + manifest.pageIdsByKey.ready + '"]'),
      ).toBeVisible();
      await expect(
        page
          .locator('[data-board-column-id="canceled"]')
          .locator('[data-board-uuid-v7="' + manifest.pageIdsByKey.dropped + '"]'),
      ).toBeVisible();
      await expect(card("needsYou").getByText("Needs your answer", { exact: true })).toBeVisible();
      await expect(card("blocked").getByText("Blocked · needs you", { exact: true })).toBeVisible();
      await expect(card("failed").getByText("Failed · needs you", { exact: true })).toBeVisible();
      await expect(card("dropped")).toHaveCount(1);
      await expect(card("dropped").locator("[data-page-turn]")).toHaveCount(0);
      await expect(page.getByText("Canceled", { exact: true }).first()).toBeVisible();
      await expect(card("ask").getByRole("button", { name: "Start", exact: true })).toBeVisible();
      await expect(card("dependent").getByText(/^Waiting for /u)).toBeVisible();
      await expect(card("done")).toHaveCount(1);
      await expect(
        card("chainStart").locator('[data-page-chat-activity-control="true"]'),
      ).toHaveAttribute("aria-label", /1 working chat/u);
      await expect(
        card("needsYou").locator('[data-page-chat-activity-control="true"]'),
      ).toHaveAttribute("aria-label", /1 awaiting input/u);
      await expect(card("done").locator("[data-page-turn]")).toHaveCount(0);
      await expect(card("chainStart").getByText("Codex is working", { exact: true })).toBeVisible();
      await screenshot("03-project-board");
      await card("done").scrollIntoViewIfNeeded();
      await screenshot("03-project-board-done");
      await card("dropped").scrollIntoViewIfNeeded();
      await screenshot("03-project-board-canceled");
      await openLibraryInbox();
      await message("ready").getByRole("button", { name: "Accept", exact: true }).click();
      await expect(message("ready")).toHaveCount(0);
      await screenshot("09-accepted-work");
      await page
        .locator('[data-app-action-sidebar-project-label="Nodex"]')
        .getByRole("button", { name: "Open Nodex", exact: true })
        .click();
      await openProjectBoard(page);
      await expect(
        page
          .locator('[data-board-column-id="done"]')
          .locator('[data-board-uuid-v7="' + manifest.pageIdsByKey.ready + '"]'),
      ).toBeVisible();
      await expect(card("ready").locator("[data-page-turn]")).toHaveCount(0);
      await screenshot("03-project-board-accepted");

      const held = await invokeIpc(page, "work:set-hold", {
        operationId: "e2e:pause-project",
        scope: { kind: "project", project_id: manifest.projectId },
        paused: true,
      });
      expect(held.ok).toBe(true);
      await expect(card("chainStart").getByText("Paused", { exact: true })).toBeVisible();
      await expect(card("ask").getByText("Paused", { exact: true })).toBeVisible();
      await card("ask").scrollIntoViewIfNeeded();
      await screenshot("07-paused-board");
      await card("ask").scrollIntoViewIfNeeded();
      await page
        .getByRole("button", { name: "Open Page Polish empty search results", exact: true })
        .click();
      const stage = page.locator(
        '[data-page-stage-page-id="' +
          manifest.pageIdsByKey.ask +
          '"][data-page-stage-surface="true"]:visible',
      );
      await expect(stage.locator('[data-page-stage-assignee="agent"]')).toBeVisible();
      await expect(stage.getByText("Auto-start", { exact: true })).toHaveCount(0);
      await expect(stage.getByText("Turn", { exact: true })).toHaveCount(0);
      await expect(
        stage.getByRole("button", { name: "Resume Project", exact: true }),
      ).toBeVisible();
      await expect(stage.locator('[data-page-turn="paused"]')).toHaveAttribute(
        "aria-label",
        "You paused this Project",
      );
      await stage.locator('[data-page-turn="paused"]').hover();
      await expect(page.getByRole("tooltip")).toContainText("You paused this Project");
      await screenshot("08-paused-page");
      await stage.getByRole("button", { name: "Resume Project", exact: true }).click();
      await expect
        .poll(() =>
          invokeIpc(page, "work:effective-hold", {
            kind: "page",
            page_id: manifest.pageIdsByKey.ask!,
          }),
        )
        .toEqual([]);
      await expect(stage.getByRole("button", { name: "Start", exact: true })).toBeVisible();
      await expect(card("chainStart").getByText("Codex is working", { exact: true })).toBeVisible();
      // Status carries whose move it is; there is no separate Turn row.
      await expect(
        stage.locator('[data-page-stage-property-id="status"] [data-page-turn-line="true"]'),
      ).toContainText("Ready to start");
      await expect(stage.locator('[data-page-stage-assignee="agent"]')).toContainText("GPT-5.5");
      await expect(stage.locator('[data-page-stage-assignee="agent"]')).not.toContainText("Medium");
      await stage.getByRole("button", { name: "Choose Assignee", exact: true }).click();
      await expect(
        page.getByRole("switch", { name: "Start automatically", exact: true }),
      ).toHaveAttribute("aria-checked", "false");
      await page.keyboard.press("Escape");
      await screenshot("04-page-agent-work");
      await openLibraryInbox();
      await expect(message("ready")).toHaveCount(0);
    },
  );
});
