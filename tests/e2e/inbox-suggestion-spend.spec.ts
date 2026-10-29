import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { INBOX_SUGGESTION_SPEND_SCENARIO_ID } from "../../scripts/scenarios/scenarios/inbox-suggestion-spend";
import { invokeIpc } from "./support/editor-scenario";

const NOW_S = Math.floor(Date.now() / 1000);
/** Codex reports a weekly window two days in with 4% left: spending faster than its time. */
const TIGHT_WEEKLY_USAGE = {
  limitId: "codex",
  limitName: null,
  primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: NOW_S + 3 * 3600 },
  secondary: { usedPercent: 96, windowDurationMins: 10_080, resetsAt: NOW_S + 5 * 86_400 },
  credits: null,
  planType: "plus",
  rateLimitReachedType: null,
};

const primaryShortcut = (key: string) =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;
const OUTDATED_NOTE = "Suggested before this message changed";

const shot = async (page: Page, target: Locator, file: string) => {
  const box = await target.boundingBox();
  if (!box) throw new Error(`${file} is not on screen`);
  await page.screenshot({ path: file, clip: box });
};

test("Inbox advice answers a send, survives edits, and steps back while usage runs short", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const artifacts =
    process.env.NODEX_INBOX_SUGGESTION_SPEND_ARTIFACT_DIR ??
    testInfo.outputPath("inbox-suggestion-spend");
  await mkdir(artifacts, { recursive: true });
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  await withElectronScenario(
    {
      label: "inbox-suggestion-spend",
      scenarioId: INBOX_SUGGESTION_SPEND_SCENARIO_ID,
      seedThrough: "core",
      environment: { NODEX_FAKE_CODEX_RATE_LIMITS: JSON.stringify(TIGHT_WEEKLY_USAGE) },
    },
    async ({ application, manifest, page, seed }) => {
      if (!manifest) throw new Error("The scenario did not materialize");
      const ids = manifest.pageIdsByKey;
      // Only the user asks for advice here, so no Agent is ever started.
      await invokeIpc(page, "settings:inbox:update", { suggestions: "on_request" });
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
      });
      const inbox = page.locator('[data-inbox-scope="library"]');
      const stream = inbox.getByTestId("inbox-stream");
      const row = (key: string) => inbox.locator(`[data-inbox-page-id="${ids[key]}"]`);
      const spinner = (target: Locator) =>
        target.getByRole("status", { name: "Finding where this goes" });
      const suggestionState = async (key: string) =>
        (await seed.readInbox("inbox")).items.find((item) => item.pageId === ids[key])
          ?.suggestionState;

      let status: "passed" | "failed" = "failed";
      let failure: string | null = null;
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1440, height: 900 },
      });
      await page.screencast.showActions({
        position: "bottom",
        style: { title: "font-size: 14px" },
      });
      try {
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        await expect(inbox).toBeVisible();
        await expect(row("outdated").getByText(OUTDATED_NOTE)).toBeVisible();
        // The Inbox settles into place before it is captured.
        await page.waitForTimeout(600);
        await shot(page, stream, path.join(artifacts, "1-advice-states.png"));
        claim(
          "Each message shows where its advice stands",
          {
            current: { note: 0, decision: 1 },
            outdated: { note: 1, decision: 1, suggestAgain: 1 },
            unrequested: { suggest: 1, spinner: 0 },
          },
          {
            current: {
              note: await row("current").getByText(OUTDATED_NOTE).count(),
              decision: await row("current")
                .getByRole("button", { name: /New chat in/ })
                .count(),
            },
            outdated: {
              note: await row("outdated").getByText(OUTDATED_NOTE).count(),
              decision: await row("outdated")
                .getByRole("button", { name: /New chat in/ })
                .count(),
              suggestAgain: await row("outdated")
                .getByRole("button", { name: "Suggest again", exact: true })
                .count(),
            },
            unrequested: {
              suggest: await row("unrequested")
                .getByRole("button", { name: "Suggest", exact: true })
                .count(),
              spinner: await spinner(row("unrequested")).count(),
            },
          },
        );

        // Opening a message's Page reads it; the suggestion beside it stays current.
        const current = row("current");
        await current.getByTestId("inbox-message-unit").hover();
        await current.getByRole("button", { name: "Message actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Open page", exact: true }).click();
        const editor = page
          .locator('.nfm-editor .ProseMirror[contenteditable="true"]:visible')
          .first();
        await expect(editor).toBeVisible();
        await page.waitForTimeout(2_500);
        claim(
          "Opening the Page leaves its suggestion current and asks for nothing",
          { note: 0, state: "settled" },
          {
            note: await current.getByText(OUTDATED_NOTE).count(),
            state: await suggestionState("current"),
          },
        );
        await page.screenshot({ path: path.join(artifacts, "2-page-open-beside-inbox.png") });

        // Editing the text makes the suggestion outdated, and nothing asks again on its own.
        await editor.click();
        await page.keyboard.press(primaryShortcut("ArrowDown"));
        await page.keyboard.press("End");
        const addition = " Include the mobile flow too.";
        await page.keyboard.type(addition);
        await expect(current.getByText(OUTDATED_NOTE)).toBeVisible();
        await page.waitForTimeout(3_000);
        claim(
          "An edit in the Page makes the suggestion outdated without suggesting again",
          { note: 1, spinner: 0, decision: 1, state: "settled" },
          {
            note: await current.getByText(OUTDATED_NOTE).count(),
            spinner: await spinner(current).count(),
            decision: await current.getByRole("button", { name: /New chat in/ }).count(),
            state: await suggestionState("current"),
          },
        );
        await shot(page, current, path.join(artifacts, "3-edited-outdated.png"));

        // Deleting the addition restores the text the suggestion read, so it is current again.
        await editor.click();
        await page.keyboard.press(primaryShortcut("ArrowDown"));
        await page.keyboard.press("End");
        for (let index = 0; index < addition.length; index += 1)
          await page.keyboard.press("Backspace");
        await expect(current.getByText(OUTDATED_NOTE)).toHaveCount(0);
        claim(
          "Reverting the text makes the suggestion current again",
          0,
          await current.getByText(OUTDATED_NOTE).count(),
        );

        // The Inbox's settings choose when suggestions run.
        await inbox.getByRole("button", { name: "Inbox settings", exact: true }).click();
        const when = page.getByRole("button", { name: "When to suggest", exact: true });
        await expect(when).toHaveText(/When I ask/);
        await when.click();
        const automatic = page.getByRole("menuitem", { name: /Automatically/ });
        await expect(automatic).toBeVisible();
        // The menu settles before it is captured.
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(artifacts, "4-when-to-suggest.png") });
        await automatic.click();
        await expect(when).toHaveText(/Automatically/);
        await page.keyboard.press("Escape");

        // Codex's weekly usage is running short, so automatic advice steps back.
        const paused = page.getByRole("status").filter({ hasText: "Automatic suggestions paused" });
        await expect(paused).toBeVisible();
        claim(
          "The pause names the usage that ran short",
          true,
          /Automatic suggestions paused · Codex Weekly: 4% left, resets in 5 days/.test(
            (await paused.textContent()) ?? "",
          ),
        );
        const composer = page.getByRole("textbox", { name: "Message your Inbox" });
        const sentText = "Draft release notes for the Inbox suggestion modes.";
        await composer.fill(sentText);
        await composer.press("Enter");
        const sent = inbox.getByTestId("inbox-message").filter({ hasText: sentText });
        await expect(sent).toBeVisible();
        await expect(sent.getByRole("button", { name: "Suggest", exact: true })).toBeVisible();
        await page.waitForTimeout(3_000);
        const sentId = await sent.getAttribute("data-inbox-page-id");
        claim(
          "A message sent while paused waits for the user instead of spending usage",
          { spinner: 0, state: "none" },
          {
            spinner: await spinner(sent).count(),
            state: (await seed.readInbox("inbox")).items.find((item) => item.pageId === sentId)
              ?.suggestionState,
          },
        );
        await page.screenshot({
          path: path.join(artifacts, "5-paused-while-usage-runs-short.png"),
        });
        status = "passed";
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        await page.screencast.stop();
        await writeFile(
          path.join(artifacts, "verification.json"),
          `${JSON.stringify({ status, failure, claims }, null, 2)}\n`,
        );
      }
    },
  );
});
