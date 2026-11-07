import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_ID, withAgentPeers, invoke, type NativeRecord } from "./support/agent-peers";
import { chooseComposerModel } from "./support/composer-model-picker";

const runSlashCommand = async (page: Page, id: string) => {
  await page.locator('[data-codex-composer="true"]:visible').fill(`/${id}`);
  await page.locator(`[data-slash-command-row="${id}"]`).click();
};

/** The Session whose chat Scene is on screen. */
const visibleSession = async (page: Page) =>
  (
    await page
      .locator('[data-workbench-scene-owner^="session:"]:visible')
      .first()
      .getAttribute("data-workbench-scene-owner")
  )?.slice("session:".length) ?? null;

test("continues a finished Codex chat on Claude with its history, then returns to Codex with only what it missed", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withAgentPeers(
    testInfo,
    "agent-switch",
    async ({ page, sessionId, send, records, models }) => {
      const prompts = (kind: NativeRecord["kind"]) =>
        records().filter((record) => record.kind === kind && record.event === "prompt");
      await send("Remember the codeword ORCHID", "Codex child report", 1);

      // The finished Codex chat continues on Claude, which receives the conversation so far.
      await chooseComposerModel(page, models.claude);
      await send("Continue on Claude", "Claude child report", 1);
      const claudePrompt = prompts("claude").at(-1)?.prompt ?? "";
      expect(claudePrompt).toContain("Context handoff (full_thread_summary):");
      expect(claudePrompt).toContain("Remember the codeword ORCHID");
      expect(claudePrompt).toContain("Codex child report");
      expect(claudePrompt.endsWith("User message:\nContinue on Claude")).toBe(true);
      const dividers = page
        .locator('[data-runtime-notice="agentHandoff"]')
        .filter({ visible: true });
      await expect(dividers).toHaveCount(1);
      await expect(dividers.first()).toContainText("Codex");
      await expect(dividers.first()).toContainText("Runtime Claude");
      expect(
        (await invoke(page, "agent-runtime:session:inspect", { sessionId })).thread.modelSelection
          .instanceId,
      ).toBe(CLAUDE_ID);

      // Codex resumes its own native conversation and receives only Claude's part as history.
      await chooseComposerModel(page, models.codex);
      await send("Back on Codex", "Codex child report", 2);
      expect(prompts("codex").at(-1)?.prompt).toBe("Back on Codex");
      const injected = JSON.stringify(
        records().findLast((record) => record.kind === "codex" && record.event === "inject")?.items,
      );
      expect(injected).toContain("Continue on Claude");
      expect(injected).toContain("Claude child report");
      expect(injected).not.toContain("Remember the codeword ORCHID");
      await expect(dividers).toHaveCount(2);
    },
  );
});

test("merges a fork's finished work back into the chat it came from with that chat's next message", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withAgentPeers(testInfo, "agent-merge-back", async ({ page, sessionId, send, records }) => {
    await send("Remember the codeword ORCHID", "Codex child report", 1);
    await runSlashCommand(page, "fork");
    await page
      .getByRole("button", {
        name: "Fork chat Continue this conversation in a new chat",
        exact: true,
      })
      .click();
    // The fork opens with the source's history and continues on its own.
    await expect.poll(() => visibleSession(page), { timeout: 30_000 }).not.toBe(sessionId);
    await send("Explore an alternative", "Codex child report", 2);

    await runSlashCommand(page, "merge");
    await expect.poll(() => visibleSession(page), { timeout: 30_000 }).toBe(sessionId);
    await expect(
      page.getByText("The fork's work joins your next message in this chat."),
    ).toBeVisible();
    await send("Use what the fork found", "Codex child report", 2);
    const injected = JSON.stringify(
      records().findLast((record) => record.kind === "codex" && record.event === "inject")?.items,
    );
    expect(injected).toContain("Explore an alternative");
    expect(injected).not.toContain("Remember the codeword ORCHID");
    expect(records().findLast((record) => record.event === "prompt")?.prompt).toBe(
      "Use what the fork found",
    );
    await expect(
      page.locator('[data-runtime-notice="agentHandoff"]').filter({ visible: true }),
    ).toContainText("Fork merged back");
  });
});

test("clears a chat's context so its next message starts fresh on any Agent, keeping its panels", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const evidence = process.env.NODEX_E2E_EVIDENCE_DIR ?? testInfo.outputPath("clear-context");
  fs.mkdirSync(evidence, { recursive: true });
  await withAgentPeers(testInfo, "clear-context", async ({ page, send, records, models }) => {
    const capture = async (name: string) => {
      // Assertions own settling; keep a readable frame of each verified state.
      await page.waitForTimeout(400);
      const body = await page.screenshot({
        path: path.join(evidence, `${name}.png`),
        animations: "disabled",
      });
      await testInfo.attach(name, { body, contentType: "image/png" });
    };
    const prompts = (kind: NativeRecord["kind"]) =>
      records().filter((record) => record.kind === kind && record.event === "prompt");
    const composer = page.locator('[data-codex-composer="true"]:visible');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screencast.start({
      path: path.join(evidence, "clear-context.webm"),
      size: { width: 1440, height: 900 },
    });
    await page.screencast.showActions({ position: "bottom", style: { title: "font-size: 14px" } });
    try {
      await send("Remember the codeword ORCHID", "Codex child report", 1);
      const earlier = prompts("codex").at(-1);

      // The chat's panels belong to its Session, not to its context.
      await page.getByRole("button", { name: "New tab", exact: true }).click();
      await page
        .locator("[data-new-tab-scroll-root]")
        .getByRole("button", { name: /^Files/u })
        .click();
      const files = page.getByRole("tab", { name: "Files", exact: true });
      await expect(files).toBeVisible();
      await capture("1-before-clear");

      const chatActions = page.getByRole("button", { name: "Chat actions", exact: true });
      const menuItem = page.getByRole("menuitem", { name: "Clear context", exact: true });
      await chatActions.click();
      await expect(menuItem).toBeVisible();
      await capture("2-chat-actions");
      // Escape would dismiss the Composer's next slash menu along with this one.
      await chatActions.click();
      await expect(menuItem).toBeHidden();

      await composer.fill("/clear");
      const clear = page.locator('[data-slash-command-row="clear"]');
      await expect(clear).toContainText("Clear context");
      await capture("3-slash-clear");
      await clear.click();
      const divider = page
        .locator('[data-runtime-notice="contextCleared"]')
        .filter({ visible: true });
      await expect(divider).toHaveCount(1);
      await expect(divider).toContainText("Context cleared");
      await expect(files).toBeVisible();
      await capture("4-cleared");

      // Claude takes the next message with nothing from before the clear.
      await chooseComposerModel(page, models.claude);
      await send("What is the codeword?", "Claude child report", 1);
      const claudePrompt = prompts("claude").at(-1)?.prompt ?? "";
      expect(claudePrompt).toContain("What is the codeword?");
      expect(claudePrompt).not.toContain("ORCHID");
      expect(claudePrompt).not.toContain("Context handoff");
      await expect(
        page.locator('[data-runtime-notice="agentHandoff"]').filter({ visible: true }),
      ).toHaveCount(0);
      await divider.scrollIntoViewIfNeeded();
      await capture("5-fresh-on-claude");

      // Codex starts a new native conversation that receives only what followed the clear.
      await chooseComposerModel(page, models.codex);
      await send("Back on Codex", "Codex child report", 2);
      const fresh = prompts("codex").at(-1);
      expect(fresh?.prompt).toBe("Back on Codex");
      expect(fresh?.threadId).not.toBe(earlier?.threadId);
      const injected = records().filter((record) => record.event === "inject");
      expect(injected.map((record) => record.threadId)).toEqual([fresh?.threadId]);
      expect(JSON.stringify(injected[0]?.items)).toContain("What is the codeword?");
      expect(JSON.stringify(injected[0]?.items)).not.toContain("ORCHID");
      await expect(divider).toHaveCount(1);
      await expect(files).toBeVisible();
      await capture("6-back-on-codex");
    } finally {
      await page.screencast.stop();
    }
  });
});
