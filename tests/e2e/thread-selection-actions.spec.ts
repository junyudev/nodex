import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AgentRuntimeSessionActivitySnapshot } from "../../src/shared/agent-runtime-api";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { openNewChatDraft } from "./support/new-chat-draft";

async function selectResponse(page: Page, response: Locator) {
  await response.scrollIntoViewIfNeeded();
  await response.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("button", { name: "Add to chat", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask in side chat", exact: true })).toBeVisible();
}

// Real renderer, Main, Runtime and provider input; every run owns a fresh Profile.
test("annotates selected replies and reuses a side chat without replacing its draft", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-thread-selection-"));
  const log = path.join(fixture, "provider.jsonl");
  const peer = path.join(fixture, "codex.mjs");
  const version = "0.145.0-alpha.15";
  fs.writeFileSync(
    peer,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("codex-cli ${version}"); process.exit(0); }\n${fs.readFileSync("tests/e2e/fixtures/codex-queue-app-server.mjs", "utf8").replace(/^#![^\n]*\n/u, "")}`,
  );
  const harness = await ElectronScenarioHarness.create({
    label: "thread-selection-actions",
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_STATE_PATH: path.join(fixture, "state.json"),
      NODEX_FAKE_CODEX_LOG_PATH: log,
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "300",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, peer, version);
  const turns = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { method: string; params: unknown })
          .filter((record) => record.method === "turn/start")
      : [];
  try {
    let page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    await page.evaluate(() =>
      window.api!.invoke("agent-runtime:providers:read", { refresh: true }),
    );
    const scene = await openNewChatDraft(page);
    const mainComposer = scene.locator('[data-codex-composer="true"]').first();
    await mainComposer.fill("Explain how this task completed.");
    await mainComposer.press("Enter");
    const response = scene.locator("[data-response-annotation-target] .codex-markdown").first();
    await expect(response).toContainText("The task completed successfully.", { timeout: 30_000 });
    await mainComposer.fill("Keep my main draft");
    await selectResponse(page, response);
    await page.screenshot({ path: testInfo.outputPath("selection-toolbar.png") });
    await page.getByRole("button", { name: "Add to chat", exact: true }).click();
    const note = page.getByRole("textbox", { name: "Note", exact: true });
    await expect(note).toBeFocused();
    await note.fill("Explain the completion criteria");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(mainComposer).toHaveText("Keep my main draft");
    await expect(mainComposer).toBeFocused();
    await expect(page.getByRole("button", { name: "Response annotation 1" })).toBeVisible();
    await expect(page.getByRole("button", { name: "1 annotation", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("response-annotation.png") });
    await mainComposer.press("Enter");
    await expect.poll(() => turns().length).toBe(2);
    const submitted = JSON.stringify(turns()[1]?.params);
    expect(submitted).toContain("Explain the completion criteria");
    expect(submitted).toContain("The task completed successfully.");
    expect(submitted).toContain("Response annotations:");
    await expect(scene.locator('[data-user-message-bubble="true"]').last()).toHaveText(
      "Keep my main draft",
    );
    await expect(page.getByRole("button", { name: "Response annotation 1" })).toHaveCount(0);
    await expect(scene.locator("[data-response-annotation-target]")).toHaveCount(2);
    await selectResponse(page, response);
    await page.getByRole("button", { name: "Ask in side chat", exact: true }).click();
    await expect(scene.locator('[data-codex-composer="true"]')).toHaveCount(2);
    const sideComposer = scene.locator('[data-codex-composer="true"]').last();
    await expect(sideComposer).toBeFocused();
    await expect(page.getByRole("tab", { name: "Side chat", exact: true })).toHaveCount(1);
    await expect(sideComposer).toHaveText("");
    await expect(page.getByRole("button", { name: "1 selection", exact: true })).toBeVisible();
    await sideComposer.fill("Keep my side draft");
    await selectResponse(page, response);
    await page.getByRole("button", { name: "Ask in side chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "2 selections", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Side chat", exact: true })).toHaveCount(1);
    await expect(sideComposer).toHaveText("Keep my side draft");
    expect(turns()).toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath("side-chat-selections.png") });
    await sideComposer.press("Enter");
    await expect.poll(() => turns().length, { timeout: 30_000 }).toBe(3);
    expect(JSON.stringify(turns()[2]?.params)).toContain("Selection 2");
    expect(JSON.stringify(turns()[2]?.params)).toContain("Keep my side draft");
    await expect(
      scene.locator('[data-user-message-bubble="true"]', { hasText: "Keep my side draft" }),
    ).toHaveCount(1);
    await expect(scene.locator("[data-response-annotation-target]")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const activity = (await window.api!.invoke(
            "agent-runtime:activity:read",
          )) as AgentRuntimeSessionActivitySnapshot;
          return activity.items.length;
        }),
      )
      .toBe(0);
    await selectResponse(page, response);
    await page.getByRole("button", { name: "Ask in side chat", exact: true }).click();
    await expect(sideComposer).toBeFocused();
    await expect(sideComposer).toHaveText("");
    await expect(page.getByRole("button", { name: "1 selection", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Side chat", exact: true })).toHaveCount(1);
    await sideComposer.press("Enter");
    await expect.poll(() => turns().length, { timeout: 30_000 }).toBe(4);
    await expect(scene.locator("[data-response-annotation-target]")).toHaveCount(4);
    await selectResponse(page, response);
    await page.getByRole("button", { name: "Add to chat", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Note", exact: true })
      .fill("Send this annotation directly");
    await page.getByRole("textbox", { name: "Note", exact: true }).press("Meta+Enter");
    await expect.poll(() => turns().length, { timeout: 30_000 }).toBe(5);
    expect(JSON.stringify(turns()[4]?.params)).toContain("Send this annotation directly");
    await expect(scene.locator("[data-response-annotation-target]")).toHaveCount(5);
    await harness.stopElectron();
    page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    await expect(
      page.locator('[data-user-message-bubble="true"]', { hasText: "Keep my main draft" }),
    ).toHaveCount(1, { timeout: 30_000 });
    const historyAnnotations = page.getByRole("button", { name: "1 annotation", exact: true });
    await expect(historyAnnotations).toHaveCount(2);
    await historyAnnotations.first().click();
    await expect(page.getByText("Explain the completion criteria", { exact: true })).toBeVisible();
  } catch (error) {
    await harness.page.screenshot({ path: testInfo.outputPath("failure.png") }).catch(() => {});
    await testInfo.attach("failure-state", {
      body: await harness.page
        .locator("body")
        .ariaSnapshot()
        .catch(() => "Unavailable"),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
