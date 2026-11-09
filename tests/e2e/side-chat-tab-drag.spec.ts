import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { invokeIpc } from "./support/editor-scenario";
import { openNewChatDraft } from "./support/new-chat-draft";
import { captureRendererErrors } from "./support/renderer-errors";
import { openSummaryPanel } from "./support/subagents-panel";

const tabIds = (row: Locator) =>
  row
    .locator("[data-panel-tab-id]")
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-panel-tab-id")));

/** The native gesture from drag-block-with-mouse, using tab chrome instead of a Block handle. */
async function dragTabWithMouse({
  page,
  tab,
  target,
  xRatio = 0.5,
  onFeedback,
}: {
  page: Page;
  tab: Locator;
  target: Locator;
  xRatio?: number;
  onFeedback?: () => Promise<void>;
}) {
  await tab.scrollIntoViewIfNeeded();
  const button = tab.getByRole("tab");
  // Grab the leading part of the tab, clear of its actions and Close buttons.
  await button.hover({ position: { x: 16, y: 16 } });
  const source = await button.evaluate(async (element) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    if (!element.isConnected) throw new Error("Tab remounted before mouse down");
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) throw new Error("Tab has no layout box");
    return { x: box.x + 16, y: box.y + box.height / 2 };
  });
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  try {
    await page.mouse.move(source.x + 12, source.y, { steps: 4 });
    const box = await target.boundingBox();
    if (!box) throw new Error("Tab drop target has no layout box");
    const point = { x: box.x + box.width * xRatio, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y, { steps: 30 });
    // The first move may only emit dragenter; these produce the required dragover.
    await page.mouse.move(point.x + 1, point.y + 1);
    await page.mouse.move(point.x + 2, point.y + 2);
    await onFeedback?.();
  } finally {
    await page.mouse.up();
  }
}

test("side chat tabs move between groups and survive closing, reopening, and restart", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifacts =
    process.env.NODEX_E2E_SIDE_CHAT_DRAG_ARTIFACT_DIR ?? testInfo.outputPath("side-chat-tab-drag");
  fs.mkdirSync(artifacts, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-side-chat-tab-drag-"));
  const codex = path.join(fixture, "codex");
  fs.writeFileSync(
    codex,
    `#!${process.execPath}\n${fs.readFileSync("scripts/scenarios/runtime/cross-provider-peer.mjs", "utf8").replace(/^#![^\n]*\n/u, "")}`,
    { mode: 0o755 },
  );
  const sourcePrompt = "Prepare the panel drag fixture.";
  const sidePrompt = "Keep this draggable side conversation.";
  const sideReply = "This side conversation remains attached to its source chat.";
  fs.writeFileSync(
    path.join(fixture, "plan.json"),
    JSON.stringify({
      [sourcePrompt]: { reply: "The source conversation is ready." },
      [sidePrompt]: { reply: sideReply },
    }),
  );
  const harness = await ElectronScenarioHarness.create({
    label: "side-chat-tab-drag",
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
    },
  });
  let page: Page | undefined;
  let recording = false;
  let tracing = false;
  let readRendererErrors = async () => "";
  try {
    prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex, "0.145.0-alpha.15");
    page = await harness.launch();
    const appPage = page;
    readRendererErrors = captureRendererErrors(page);
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    tracing = true;
    await harness.waitForApplicationReady();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.screencast.start({
      path: path.join(artifacts, "before-restart.webm"),
      size: { width: 1440, height: 960 },
    });
    recording = true;
    await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
    const scene = await openNewChatDraft(page);
    const owner = await scene.getAttribute("data-workbench-scene-owner");
    if (!owner?.startsWith("session:")) throw new Error("The source chat has no Session");
    const sourceId = owner.slice("session:".length);
    const send = async (composer: Locator, sessionId: string, text: string) => {
      await composer.fill(text);
      await composer.press("Enter");
      await expect
        .poll(
          async () => (await invokeIpc(appPage, "project-sessions:get", sessionId))?.executionRef,
        )
        .toBeTruthy();
      await expect
        .poll(
          async () =>
            (
              await invokeIpc(appPage, "agent-runtime:session:read", { sessionId })
            ).snapshot.projection.runs.at(-1)?.status,
          { timeout: 30_000 },
        )
        .toBe("completed");
    };
    await send(
      scene.locator('[data-codex-composer="true"]:visible').first(),
      sourceId,
      sourcePrompt,
    );
    expect(
      (await invokeIpc(page, "project-sessions:get", sourceId))?.executionRef?.threadId,
    ).toBeTruthy();

    // Files precedes the side chat, so moving the side chat to the start changes the order.
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page
      .getByRole("tabpanel", { name: "New tab", exact: true })
      .getByRole("button", { name: /^Files/u })
      .click();
    const right = scene.locator('[data-panel-group-tree="right"]');
    await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await right
      .getByRole("tabpanel", { name: "New tab", exact: true })
      .getByRole("button", { name: /^Side chat/u })
      .click();
    const openedSideTab = page.locator("[data-panel-tab-id]").filter({
      has: page.getByRole("tab", { name: "Side chat", exact: true }),
    });
    // Wait for the conversation body before retaining the durable surface identity.
    await expect(
      right
        .getByRole("tabpanel", { name: "Side chat", exact: true })
        .locator('[data-codex-composer="true"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(openedSideTab).toBeVisible();
    const tabId = await openedSideTab.getAttribute("data-panel-tab-id");
    if (!tabId) throw new Error("The side chat has no tab identity");
    const sideTab = page.locator(`[data-panel-tab-id="${tabId}"]`);
    const sideBody = scene.locator(`[role="tabpanel"][data-tab-id="${tabId}"]`);
    const composer = sideBody.locator('[data-codex-composer="true"]');
    await expect(composer).toBeVisible();
    const sideChats = await invokeIpc(page, "project-sessions:side-chats", sourceId);
    expect(sideChats.items).toHaveLength(1);
    const sideId = sideChats.items[0]!.sessionId;
    await send(composer, sideId, sidePrompt);
    await expect(sideTab.getByRole("tab", { name: sidePrompt, exact: true })).toBeVisible();
    await expect(sideBody.getByText(sideReply, { exact: true })).toBeVisible();
    const draft = "Continue this conversation after moving its tab.";
    await composer.fill(draft);
    const originalLeaf = right.locator("[data-panel-group-leaf-id]");
    await expect(originalLeaf).toHaveCount(1);
    const originalLeafId = await originalLeaf.getAttribute("data-panel-group-leaf-id");
    if (!originalLeafId) throw new Error("The right panel has no group identity");
    // Right-panel headers are portaled to the window titlebar; their row retains the group ID.
    const row = page.locator(`[data-panel-tab-row="right:${originalLeafId}"]`);
    const initialOrder = await tabIds(row);
    expect(initialOrder.length).toBeGreaterThanOrEqual(2);
    expect(initialOrder.indexOf(tabId)).toBeGreaterThan(0);
    await expect(row.locator(`[data-panel-tab-id="${tabId}"]`)).toBeVisible();
    const screenshot = (name: string) =>
      appPage.screenshot({ path: path.join(artifacts, name), animations: "disabled" });
    await screenshot("01-initial.png");

    await test.step("Reorder the side chat before the first right-panel tab", async () => {
      await dragTabWithMouse({
        page: appPage,
        tab: sideTab,
        target: row.locator("[data-panel-tab-id]").first(),
        xRatio: 0.15,
        onFeedback: async () => {
          await expect(row.locator("[data-panel-tab-insertion-marker]")).toBeAttached();
          await screenshot("02-dragging-reorder.png");
        },
      });
      await expect
        .poll(() => tabIds(row), {
          message: "The side chat tab did not move to the start of its strip",
        })
        .toEqual([tabId, ...initialOrder.filter((id) => id !== tabId)]);
      await expect(composer).toHaveText(draft);
      await screenshot("03-reordered.png");
    });

    const bottom = scene.locator('[data-panel-group-tree="bottom"]');
    await test.step("Move the side chat onto the bottom-panel tab row", async () => {
      await appPage.getByRole("button", { name: "Toggle bottom panel", exact: true }).click();
      const bottomRow = bottom.locator("[data-panel-tab-row]");
      await expect(bottomRow).toBeVisible();
      await dragTabWithMouse({
        page: appPage,
        tab: sideTab,
        target: bottomRow,
        onFeedback: async () => {
          await expect(bottomRow.locator("[data-panel-tab-insertion-marker]")).toBeAttached();
          await screenshot("04-dragging-to-bottom.png");
        },
      });
      await expect(bottom.locator(`[data-panel-tab-id="${tabId}"]`)).toBeVisible();
      await expect(right.locator(`[data-panel-tab-id="${tabId}"]`)).toHaveCount(0);
      await expect(row.locator(`[data-panel-tab-id="${tabId}"]`)).toHaveCount(0);
      await expect(bottom.locator('[data-codex-composer="true"]')).toBeVisible();
      await expect(composer).toHaveText(draft);
      await composer.fill(`${draft} Still editable.`);
      await screenshot("05-in-bottom.png");
    });

    await test.step("Split the right-panel body by dropping at its right edge", async () => {
      const leaves = right.locator("[data-panel-group-leaf-id]");
      const beforeCount = await leaves.count();
      const filesBody = right.getByRole("tabpanel", { name: "Files", exact: true });
      await expect(filesBody).toBeVisible();
      await dragTabWithMouse({
        page: appPage,
        tab: sideTab,
        target: filesBody,
        xRatio: 0.95,
        onFeedback: async () => {
          await expect(right.locator('[data-panel-group-drop-zone="right"]')).toBeVisible();
          await screenshot("06-dragging-split.png");
        },
      });
      await expect(leaves).toHaveCount(beforeCount + 1);
      const newLeaf = leaves.filter({
        has: appPage.locator(`[role="tabpanel"][data-tab-id="${tabId}"]`),
      });
      await expect(newLeaf).toHaveCount(1);
      await expect(newLeaf).not.toHaveAttribute("data-panel-group-leaf-id", originalLeafId);
      const newLeafId = await newLeaf.getAttribute("data-panel-group-leaf-id");
      if (!newLeafId) throw new Error("The split group has no identity");
      await expect
        .poll(() => tabIds(appPage.locator(`[data-panel-tab-row="right:${newLeafId}"]`)))
        .toEqual([tabId]);
      await expect(bottom.locator(`[data-panel-tab-id="${tabId}"]`)).toHaveCount(0);
      await expect(newLeaf.locator('[data-codex-composer="true"]')).toBeVisible();
      await expect(composer).toHaveText(`${draft} Still editable.`);
      await screenshot("07-split.png");
    });

    await test.step("Close the tab and reopen the attached side chat from Summary", async () => {
      await sideTab.getByRole("button", { name: `Close ${sidePrompt} tab`, exact: true }).click();
      await expect(sideTab).toHaveCount(0);
      await expect(appPage.getByRole("dialog")).toHaveCount(0);
      expect((await invokeIpc(appPage, "project-sessions:get", sideId))?.id).toBe(sideId);
      const summary = await openSummaryPanel(appPage);
      await expect(summary.getByText("Side chats", { exact: true })).toBeVisible();
      const summaryRow = summary.getByRole("button", { name: sidePrompt, exact: true });
      await expect(summaryRow).toBeVisible();
      await screenshot("08-closed.png");
      await summaryRow.click();
      const reopenedTab = appPage.locator("[data-panel-tab-id]").filter({
        has: appPage.getByRole("tab", { name: sidePrompt, exact: true }),
      });
      await expect(reopenedTab).toBeVisible();
      const reopenedId = await reopenedTab.getAttribute("data-panel-tab-id");
      if (!reopenedId) throw new Error("The reopened side chat has no surface identity");
      const reopenedBody = right.locator(`[role="tabpanel"][data-tab-id="${reopenedId}"]`);
      await expect(reopenedBody.getByText(sideReply, { exact: true })).toBeVisible();
      await expect(reopenedBody.locator('[data-codex-composer="true"]')).toBeVisible();
      await screenshot("09-reopened.png");
    });
    expect(await readRendererErrors()).toBe("");
    await page.screencast.stop();
    recording = false;
    await page.context().tracing.stop({ path: path.join(artifacts, "before-restart-trace.zip") });
    tracing = false;

    await test.step("Restore the right-panel side chat after restarting Electron", async () => {
      page = await harness.restart();
      readRendererErrors = captureRendererErrors(page);
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracing = true;
      await page.screencast.start({
        path: path.join(artifacts, "after-restart.webm"),
        size: { width: 1440, height: 960 },
      });
      recording = true;
      const restoredScene = page.locator(`[data-workbench-scene-owner="session:${sourceId}"]`);
      await expect(restoredScene).toBeVisible();
      const restoredTab = page.locator("[data-panel-tab-id]").filter({
        has: page.getByRole("tab", { name: sidePrompt, exact: true }),
      });
      await expect(restoredTab).toBeVisible();
      const restoredId = await restoredTab.getAttribute("data-panel-tab-id");
      const restoredBody = restoredScene.locator(
        `[data-panel-group-tree="right"] [role="tabpanel"][data-tab-id="${restoredId}"]`,
      );
      // A relaunch reloads the side chat's transcript from its Runtime before it shows.
      await expect(restoredBody.getByText(sideReply, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(restoredBody.locator('[data-codex-composer="true"]')).toBeVisible();
      expect((await invokeIpc(page, "project-sessions:get", sideId))?.displayTitle).toBe(
        sidePrompt,
      );
      await page.screenshot({
        path: path.join(artifacts, "10-restored.png"),
        animations: "disabled",
      });
    });
    expect(await readRendererErrors()).toBe("");
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({
        path: path.join(artifacts, "99-failure.png"),
        animations: "disabled",
      });
      await testInfo.attach("failure-state", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/plain",
      });
    }
    throw error;
  } finally {
    try {
      if (recording && page && !page.isClosed()) await page.screencast.stop();
      if (tracing && page)
        await page.context().tracing.stop({ path: path.join(artifacts, "trace.zip") });
      await testInfo.attach("renderer-errors", {
        body: await readRendererErrors(),
        contentType: "text/plain",
      });
      await testInfo.attach("runtime.log", {
        body: await readBoundedElectronRuntimeLogs(harness.profile, 100_000),
        contentType: "text/plain",
      });
    } finally {
      await harness.close();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
});
