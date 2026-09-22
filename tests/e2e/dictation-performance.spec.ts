import type { DictationRecordingMetadata } from "../../src/shared/dictation-history";
import { expect, test } from "@playwright/test";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  installDictationPolicyHttpFixture,
  readDictationPolicyHttpEvidence,
} from "./fixtures/dictation-policy-http";
import { dictationDiagnosticsFixture } from "../fixtures/dictation-diagnostics";

test("shows the persisted dictation route and performance evidence in Voice settings", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({ label: "dictation-performance" });
  try {
    const launchWithPolicy = async () => {
      const page = await harness.launch({ phase: "first-window" });
      await installDictationPolicyHttpFixture(harness.application);
      await harness.waitForApplicationReady();
      await expect
        .poll(
          async () => {
            await page.evaluate(() => window.api!.invoke("codex:account:read"));
            return page.evaluate(() => window.api!.invoke("codex:dictation:state:read"));
          },
          { timeout: 30_000 },
        )
        .toMatchObject({
          isEnabled: true,
          authMethod: "chatgpt",
          capabilities: {
            composer: true,
            global: false,
            sounds: true,
            streaming: "available",
            voiceDictionary: false,
          },
        });
      const evidence = await readDictationPolicyHttpEvidence(harness.application);
      expect(evidence.bootstrapRequests).toBeGreaterThan(0);
      expect(evidence.invalidRequests).toEqual([]);
      return page;
    };
    const page = await launchWithPolicy();
    const diagnostics = dictationDiagnosticsFixture();
    await page.evaluate(async (diagnostics) => {
      const api = window.api!;
      const id = "dictation-performance-fixture";
      await api.invoke("codex:dictation:history:create", {
        id,
        surface: "global",
        mimeType: "audio/webm",
      });
      await api.invoke("codex:dictation:history:append", {
        id,
        chunk: new Uint8Array([1, 2, 3, 4]),
      });
      await api.invoke("codex:dictation:history:finalize", {
        id,
        durationMs: 12_000,
        status: "completed",
      });
      await api.invoke("codex:dictation:history:set-transcript", {
        id,
        transcript: "Ship the dictation performance details.",
      });
      await api.invoke("codex:dictation:history:set-diagnostics", { id, diagnostics });
    }, diagnostics);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByTestId("settings-route-shell")
      .getByRole("link", { name: "Voice", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Auto-detect", exact: true })).toBeVisible();
    await expect
      .poll(
        async () => (await readDictationPolicyHttpEvidence(harness.application)).settingsRequests,
      )
      .toBeGreaterThan(0);
    // Exercise the production Main-to-workbench recovery navigation boundary.
    await harness.application.evaluate(({ webContents }, recordingId) => {
      const primary = webContents
        .getAllWebContents()
        .find(
          (contents) => contents.getType() === "window" && contents.getURL().includes("index.html"),
        );
      if (!primary) throw new Error("The isolated primary renderer is unavailable");
      primary.send("dictation:open-recording", { recordingId });
    }, "dictation-performance-fixture");
    const focusedRecording = page
      .getByText("Ship the dictation performance details.", { exact: true })
      .locator('xpath=ancestor::*[@tabindex="-1"][1]');
    await expect(focusedRecording).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath("voice-history-recording.png"),
      fullPage: true,
    });
    await testInfo.attach("Voice settings focused recording", {
      path: testInfo.outputPath("voice-history-recording.png"),
      contentType: "image/png",
    });
    const details = page.locator("details").filter({ hasText: "Performance details" });
    await expect(details.locator("summary")).toContainText("Buffered upload · 1.34 s after stop");
    await details.locator("summary").click();
    await expect(details.getByText("abnormal-close", { exact: true })).toBeVisible();
    await expect(
      details
        .locator("dl > div")
        .filter({ has: page.getByText("Handshake completed", { exact: true }) })
        .locator("dd"),
    ).toHaveText("Yes");
    await expect(
      details
        .locator("dl > div")
        .filter({ has: page.getByText("Result used", { exact: true }) })
        .locator("dd"),
    ).toHaveText("No");
    await expect(details.getByText("Text cleanup · gpt-5.6-luna", { exact: true })).toBeVisible();
    await details.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("dictation-performance.png"),
      fullPage: true,
    });
    await testInfo.attach("Dictation performance details", {
      path: testInfo.outputPath("dictation-performance.png"),
      contentType: "image/png",
    });
    await harness.stopElectron();
    await launchWithPolicy();
    const [recording] = await harness.page.evaluate(
      () =>
        window.api!.invoke("codex:dictation:history:list") as Promise<DictationRecordingMetadata[]>,
    );
    expect(recording?.diagnostics).toEqual(diagnostics);
  } finally {
    await harness.close();
  }
});
