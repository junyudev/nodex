import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft } from "./support/agent-smoke-harness";

// A 192 by 96 PNG, so a loaded thumbnail reports real pixels.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMAAAABgCAIAAADEouq+AAABBklEQVR4nO3SQQkAIADAQMMaxzgGtIN7iHBwAfbYmGvDtfG8gK8ZiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEcgBRsybr72+iHwAAAABJRU5ErkJggg==",
  "base64",
);

test("a chat draft keeps its pasted image across a reload", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const artifacts =
    process.env.NODEX_MESSAGE_CONTENT_ARTIFACT_DIR ?? testInfo.outputPath("composer-image-drafts");
  await mkdir(artifacts, { recursive: true });
  const harness = await ElectronScenarioHarness.create({
    label: "composer-image-drafts",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.join(process.cwd(), "tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  try {
    const page = await harness.launch();
    await createAgentSmokeDraft(page, harness.profile.runRoot, "Image drafts");
    const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
    await composer.click();
    await composer.fill("Why is this cut off?");
    await composer.evaluate((element, base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "toolbar.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    }, PNG.toString("base64"));
    const thumbnail = page.getByRole("button", { name: "toolbar.png", exact: true });
    await expect(thumbnail).toBeVisible();
    // The draft keeps the image once it has been saved where the draft can find it again.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const api = (
            window as unknown as {
              api?: { invoke(channel: string, ...values: unknown[]): Promise<unknown> };
            }
          ).api;
          const snapshot = (await api?.invoke("persisted-atom:sync-request")) as
            | { values?: Record<string, unknown> }
            | undefined;
          return JSON.stringify(snapshot?.values?.["composer-image-drafts-v1"] ?? {});
        }),
      )
      .toContain("toolbar.png");

    await page.reload();
    await page.evaluate(() => window.api?.awaitInitialization?.());
    // Back to the same unsent chat, as a person returns to it.
    await page.getByRole("button", { name: "Start new chat in Image drafts", exact: true }).click();
    const restored = page.getByRole("button", { name: "toolbar.png", exact: true });
    await expect(restored).toBeVisible();
    await expect
      .poll(() =>
        restored
          .locator("img")
          .evaluate((image: HTMLImageElement) => (image.complete ? image.naturalWidth : 0)),
      )
      .toBe(192);
    await expect(composer).toHaveText("Why is this cut off?");
    await page.screenshot({ path: path.join(artifacts, "restored-draft.png") });
  } finally {
    await harness.close();
  }
});
