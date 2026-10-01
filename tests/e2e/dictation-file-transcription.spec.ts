import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import type {
  DictationRecordingAudio,
  DictationRecordingMetadata,
} from "../../src/shared/dictation-history";
import {
  installDictationPolicyHttpFixture,
  readDictationPolicyHttpEvidence,
} from "./fixtures/dictation-policy-http";

const transcript = "The selected recording is transcribed and saved.";
const fileName = "selected-recording.webm";
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const listRecordings = (page: Page) =>
  page.evaluate(
    () =>
      window.api!.invoke("codex:dictation:history:list") as Promise<DictationRecordingMetadata[]>,
  );

const readAudio = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const audio = (await window.api!.invoke(
      "codex:dictation:history:read-audio",
      id,
    )) as DictationRecordingAudio;
    return { recording: audio.recording, bytes: Array.from(audio.bytes) };
  }, id);

const openVoice = async (page: Page): Promise<void> => {
  const settings = page.getByTestId("settings-route-shell");
  const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
  // The restored Settings scene and the ordinary workbench mount asynchronously.
  await expect(settings.or(settingsButton).first()).toBeVisible();
  if (!(await settings.isVisible())) await settingsButton.click();
  await settings.getByRole("link", { name: "Voice", exact: true }).click();
};

test("transcribes a selected WebM into Voice history without microphone access", async ({}, testInfo) => {
  test.setTimeout(120_000);
  // Synthetic 440 Hz tone, generated once with:
  // ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.25 -ac 1 -c:a libopus -b:a 32k -f webm dictation-tone.webm
  const originalBytes = Array.from(
    await readFile(path.resolve("tests/e2e/fixtures/dictation-tone.webm")),
  );
  const harness = await ElectronScenarioHarness.create({ label: "dictation-file-transcription" });
  const artifactDirectory =
    process.env.NODEX_DICTATION_FILE_UI_ARTIFACT_DIR ?? testInfo.outputPath("ui-review");
  await mkdir(artifactDirectory, { recursive: true });
  let recordingPage: Page | null = null;
  try {
    const readPermissions = () =>
      harness.application.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              dictationFileImportEvidence: { dialogCalls: number; microphonePermissions: number };
            }
          ).dictationFileImportEvidence,
      );
    const launchWithPolicy = async () => {
      const page = await harness.launch({ phase: "first-window" });
      await installDictationPolicyHttpFixture(harness.application, {
        composer: false,
        transcription: transcript,
        expectedAudioBytes: originalBytes,
      });
      await harness.application.evaluate(({ systemPreferences }) => {
        const evidence = { dialogCalls: 0, microphonePermissions: 0 };
        Object.assign(globalThis, { dictationFileImportEvidence: evidence });
        systemPreferences.getMediaAccessStatus = () => "denied";
        systemPreferences.askForMediaAccess = async () => {
          evidence.microphonePermissions += 1;
          throw new Error("File transcription attempted to request microphone access");
        };
      });
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
          authMethod: "chatgpt",
          capabilities: { history: true, composer: false, global: false },
        });
      await page.evaluate(() => {
        Object.assign(globalThis, { dictationFileMicrophoneCalls: 0 });
        navigator.mediaDevices.getUserMedia = async () => {
          const target = globalThis as typeof globalThis & { dictationFileMicrophoneCalls: number };
          target.dictationFileMicrophoneCalls += 1;
          throw new Error("File transcription attempted to acquire a microphone");
        };
      });
      await page.setViewportSize({ width: 1280, height: 800 });
      return page;
    };
    const page = await launchWithPolicy();
    await openVoice(page);
    const sourcePath = path.join(harness.profile.runRoot, fileName);
    await writeFile(sourcePath, Uint8Array.from(originalBytes));
    await harness.application.evaluate(({ dialog }, sourcePath) => {
      const target = globalThis as typeof globalThis & {
        dictationFileImportEvidence: { dialogCalls: number; microphonePermissions: number };
      };
      dialog.showOpenDialog = async () => {
        target.dictationFileImportEvidence.dialogCalls += 1;
        const canceled = target.dictationFileImportEvidence.dialogCalls === 1;
        return { canceled, filePaths: canceled ? [] : [sourcePath], bookmarks: [] };
      };
    }, sourcePath);
    const importButton = page.getByRole("button", { name: "Transcribe WebM…", exact: true });
    await expect(importButton).toBeEnabled();
    await importButton.scrollIntoViewIfNeeded();
    await expect.poll(() => listRecordings(page)).toEqual([]);
    await page.screencast.start({
      path: path.join(artifactDirectory, "review.webm"),
      size: { width: 1280, height: 800 },
      annotate: { position: "bottom", fontSize: 14 },
    });
    recordingPage = page;
    await importButton.click();
    await expect.poll(async () => (await readPermissions()).dialogCalls).toBe(1);
    await expect(importButton).toBeEnabled();
    const cancellation = {
      recordings: (await listRecordings(page)).length,
      transcriptionRequests: (await readDictationPolicyHttpEvidence(harness.application))
        .transcriptionBytes.length,
    };
    expect(cancellation).toEqual({ recordings: 0, transcriptionRequests: 0 });
    await importButton.click();
    await expect(page.getByText(transcript, { exact: true })).toBeVisible();
    await expect(page.getByText(`${fileName} ·`, { exact: false })).toBeVisible();
    await expect(importButton).toBeEnabled();
    await expect
      .poll(() => listRecordings(page))
      .toEqual([
        expect.objectContaining({
          surface: "file",
          fileName,
          status: "completed",
          mimeType: "audio/webm",
          sizeBytes: originalBytes.length,
          transcript,
          diagnostics: expect.objectContaining({
            source: "file",
            transport: "buffered",
            outcome: "completed",
          }),
        }),
      ]);
    const [recording] = await listRecordings(page);
    if (!recording) throw new Error("Imported recording disappeared after transcription");
    const saved = await readAudio(page, recording.id);
    expect(saved.bytes).toEqual(originalBytes);
    await expect(
      page.locator("details").filter({ hasText: "Performance details" }).locator("summary"),
    ).toContainText(/Buffered upload · .+ total/u);
    const http = await readDictationPolicyHttpEvidence(harness.application);
    expect(http.invalidRequests).toEqual([]);
    expect(http.transcriptionBytes).toHaveLength(1);
    const permissions = await readPermissions();
    expect(permissions).toEqual({ dialogCalls: 2, microphonePermissions: 0 });
    const microphoneCalls = await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { dictationFileMicrophoneCalls: number })
          .dictationFileMicrophoneCalls,
    );
    expect(microphoneCalls).toBe(0);
    await page.getByText(transcript, { exact: true }).scrollIntoViewIfNeeded();
    const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    await expect(page.getByText("Recording transcribed", { exact: true })).toHaveCount(0);
    await page.getByRole("heading", { name: "Voice", exact: true }).hover();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.screenshot({ path: path.join(artifactDirectory, "final.png"), fullPage: true });
    // Keep the verified result visible briefly in the native review recording.
    await page.waitForTimeout(600);
    await page.screencast.stop();
    recordingPage = null;
    await unlink(sourcePath);
    await harness.stopElectron();
    const restarted = await launchWithPolicy();
    await openVoice(restarted);
    await expect(restarted.getByText(transcript, { exact: true })).toBeVisible();
    const retained = await readAudio(restarted, recording.id);
    expect(retained.bytes).toEqual(originalBytes);
    expect(retained.recording).toMatchObject({
      id: recording.id,
      surface: "file",
      fileName,
      transcript,
    });
    expect(
      (await readDictationPolicyHttpEvidence(harness.application)).transcriptionBytes,
    ).toHaveLength(0);
    const expectedHash = hash(Uint8Array.from(originalBytes));
    await writeFile(
      path.join(artifactDirectory, "result.json"),
      JSON.stringify(
        {
          status: "passed",
          fixture: "isolated dictation ChatGPT account + synthetic 440 Hz Opus WebM",
          assertions: {
            cancelledPicker: {
              expected: { recordings: 0, transcriptionRequests: 0 },
              actual: cancellation,
            },
            importedAudio: { expected: expectedHash, actual: hash(Uint8Array.from(saved.bytes)) },
            retainedAudioAfterSourceRemovalAndRestart: {
              expected: expectedHash,
              actual: hash(Uint8Array.from(retained.bytes)),
            },
            transcript: { expected: transcript, actual: retained.recording.transcript },
            microphonePermissionRequests: {
              expected: 0,
              actual: permissions.microphonePermissions,
            },
            microphoneAcquisitions: { expected: 0, actual: microphoneCalls },
            fileName: { expected: fileName, actual: retained.recording.fileName },
            authenticatedUpload: {
              expected: { requests: 1, invalidRequests: [] },
              actual: {
                requests: http.transcriptionBytes.length,
                invalidRequests: http.invalidRequests,
              },
            },
          },
          recording: retained.recording,
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(artifactDirectory, "README.md"),
      "# WebM file transcription\n\nVoice settings imports and transcribes a selected WebM without microphone permission. Cancelling the picker adds no recording or request. The saved audio and text survive removal of the source file and an application restart.\n\nThe short native recording shows cancelling and importing. `result.json` records exact byte hashes, account-validated upload, persisted text, and zero microphone permission requests. Every assertion passed.\n",
    );
    await testInfo.attach("WebM transcription result", {
      path: path.join(artifactDirectory, "final.png"),
      contentType: "image/png",
    });
  } finally {
    if (recordingPage) await recordingPage.screencast.stop().catch(() => undefined);
    try {
      await writeFile(
        testInfo.outputPath("runtime.log"),
        await readBoundedElectronRuntimeLogs(harness.profile),
      );
    } finally {
      await harness.close();
    }
  }
});
