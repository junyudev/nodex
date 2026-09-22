import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import type { DictationRecordingMetadata } from "../../src/shared/dictation-history";
import type { CodexDictationStateSnapshot } from "../../src/shared/types";
import {
  installDictationPolicyHttpFixture,
  readDictationPolicyHttpEvidence,
} from "./fixtures/dictation-policy-http";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const draft = "Keep my draft.";
const bufferedTranscript = "Buffered recording is ready.";
const streamingTranscript = "Streamed recording is ready.";
const readRecordings = (page: Page) =>
  page.evaluate(
    () =>
      window.api!.invoke("codex:dictation:history:list") as Promise<DictationRecordingMetadata[]>,
  );

const waitForRecordedAudio = (page: Page) =>
  expect
    .poll(
      async () => {
        const recordings = await readRecordings(page);
        return recordings.find((recording) => recording.status === "recording")?.sizeBytes ?? 0;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

/** A continuously varying fake microphone signal, processed by Chromium's real capture device. */
const microphoneWave = (): Buffer => {
  const sampleRate = 48_000;
  const samples = sampleRate * 4;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate;
    const envelope = 0.22 + 0.12 * Math.sin(2 * Math.PI * 1.5 * time);
    buffer.writeInt16LE(
      Math.round(32_767 * envelope * Math.sin(2 * Math.PI * 220 * time)),
      44 + index * 2,
    );
  }
  return buffer;
};

const installStreamService = async (page: Page) => {
  const evidence = {
    sessions: 0,
    closed: 0,
    completed: 0,
    frames: 0,
    bytes: 0,
    nonzeroAudio: false,
    sampleRates: [] as number[],
    invalidMessages: [] as string[],
  };
  await page.routeWebSocket("wss://chatgpt.com/backend-api/dictation/stream", (socket) => {
    const protocols = socket.protocols();
    if (
      protocols.length !== 3 ||
      protocols[0] !== "chatgpt-dictation" ||
      !protocols[1]?.startsWith("openai-bearer.fixture.") ||
      protocols[2] !== "codex-desktop"
    ) {
      evidence.invalidMessages.push("Invalid authenticated socket subprotocols");
    }
    evidence.sessions += 1;
    const sessionId = `fixture-${evidence.sessions}`;
    let sequence = 0;
    let segmentSent = false;
    const sendSession = (
      type: "session.started" | "session.updated",
      status: "active" | "closed",
    ) =>
      socket.send(
        JSON.stringify({
          type,
          sequence_no: ++sequence,
          session: {
            session_id: sessionId,
            status,
            config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" },
          },
        }),
      );
    socket.onClose(() => {
      evidence.closed += 1;
    });
    socket.onMessage((message) => {
      const value = JSON.parse(message.toString()) as {
        type: string;
        audio?: string;
        config?: {
          input_audio_format?: string;
          sample_rate_hz?: number;
          num_channels?: number;
          transcript_delivery_mode?: string;
        };
      };
      if (value.type === "session.start") {
        const config = value.config;
        if (
          config?.input_audio_format !== "pcm16" ||
          config.num_channels !== 1 ||
          config.transcript_delivery_mode !== "segment" ||
          typeof config.sample_rate_hz !== "number"
        ) {
          evidence.invalidMessages.push("Invalid PCM session configuration");
          return;
        }
        evidence.sampleRates.push(config.sample_rate_hz);
        sendSession("session.started", "active");
        return;
      }
      if (value.type === "audio.append" && typeof value.audio === "string") {
        const pcm = Buffer.from(value.audio, "base64");
        evidence.frames += 1;
        evidence.bytes += pcm.byteLength;
        evidence.nonzeroAudio ||= pcm.some((byte) => byte !== 0);
        if (segmentSent) return;
        segmentSent = true;
        socket.send(
          JSON.stringify({
            type: "transcript.segment",
            sequence_no: ++sequence,
            utterance_id: "utterance-1",
            revision: 1,
            text: streamingTranscript,
          }),
        );
        return;
      }
      if (value.type === "session.close") {
        evidence.completed += 1;
        socket.send(
          JSON.stringify({
            type: "transcript.final",
            sequence_no: ++sequence,
            utterance_id: "utterance-1",
            revision: 2,
            text: streamingTranscript,
          }),
        );
        sendSession("session.updated", "closed");
        return;
      }
      evidence.invalidMessages.push(`Unexpected message: ${value.type}`);
    });
  });
  return evidence;
};

test("records, cancels and inserts dictation through legacy and streaming Composer presentations", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const launcher = testInfo.outputPath("electron-fake-media.sh");
  await mkdir(path.dirname(launcher), { recursive: true });
  const executable = createRequire(path.join(process.cwd(), "package.json"))("electron") as string;
  const audio = testInfo.outputPath("microphone.wav");
  await writeFile(audio, microphoneWave());
  await writeFile(
    launcher,
    [
      "#!/bin/sh",
      `exec ${shellQuote(executable)} --use-fake-device-for-media-stream --use-fake-ui-for-media-stream ${shellQuote(`--use-file-for-fake-audio-capture=${audio}`)} --autoplay-policy=no-user-gesture-required "$@" ${shellQuote(process.cwd())}`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );

  for (const streaming of [false, true]) {
    const mode = streaming ? "streaming" : "legacy";
    const harness = await ElectronScenarioHarness.create({
      label: `dictation-composer-${mode}`,
      executablePath: launcher,
    });
    let service: Awaited<ReturnType<typeof installStreamService>> | undefined;
    const rendererErrors: string[] = [];
    try {
      const page = await harness.launch({ phase: "first-window" });
      page.on("pageerror", (error) => rendererErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") rendererErrors.push(message.text());
      });
      await harness.application.evaluate(({ app, systemPreferences }) => {
        if (!app.commandLine.hasSwitch("use-fake-device-for-media-stream")) {
          throw new Error("The isolated fake microphone was not enabled");
        }
        // Stub only macOS TCC: Chromium supplies the actual synthetic capture device.
        systemPreferences.getMediaAccessStatus = () => "granted";
      });
      await installDictationPolicyHttpFixture(harness.application, {
        streaming,
        transcription: bufferedTranscript,
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
          capabilities: { composer: true, streaming: streaming ? "available" : "unavailable" },
        });
      service = await installStreamService(page);
      const streamEvidence = service;
      // Playwright installs its WebSocket boundary as an init script; activate it before capture.
      await page.reload();
      await harness.waitForApplicationReady();
      await page.getByRole("button", { name: "New chat", exact: true }).first().click();
      const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
      await expect(composer).toBeVisible();
      await composer.pressSequentially(draft);
      await expect(composer).toHaveText(draft);
      await page.getByRole("button", { name: "Dictate", exact: true }).click();
      const stop = page.getByRole("button", { name: "Stop dictation", exact: true });
      await expect(stop).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.api!.invoke("codex:dictation:history:list")))
        .toEqual([expect.objectContaining({ surface: "composer", status: "recording" })]);
      await waitForRecordedAudio(page);
      if (streaming) {
        await expect(composer).toHaveText(`${draft} ${streamingTranscript}`);
        await expect(stop.locator("canvas")).toBeVisible();
        await expect.poll(() => streamEvidence.frames).toBeGreaterThan(3);
      } else {
        await expect(
          page.getByRole("button", { name: "Cancel dictation", exact: true }),
        ).toBeVisible();
      }
      // Move away from controls so the recording presentation, not a hover tooltip, is captured.
      await page.mouse.move(20, 20);
      await page.screenshot({ path: testInfo.outputPath(`${mode}-recording.png`), fullPage: true });
      await testInfo.attach(`${mode} Composer recording`, {
        path: testInfo.outputPath(`${mode}-recording.png`),
        contentType: "image/png",
      });
      if (streaming) await composer.press("Escape");
      else await page.getByRole("button", { name: "Cancel dictation", exact: true }).click();
      await expect(page.getByRole("button", { name: "Dictate", exact: true })).toBeVisible();
      await expect(composer).toHaveText(draft);
      await expect
        .poll(() => page.evaluate(() => window.api!.invoke("codex:dictation:history:list")))
        .toEqual([expect.objectContaining({ status: "cancelled" })]);

      await page.getByRole("button", { name: "Dictate", exact: true }).click();
      await expect(stop).toBeVisible();
      await waitForRecordedAudio(page);
      if (streaming) await expect(composer).toContainText(streamingTranscript);
      await stop.click();
      await expect(page.getByRole("button", { name: "Dictate", exact: true })).toBeVisible();
      await expect(composer).toHaveText(
        `${draft} ${streaming ? streamingTranscript : bufferedTranscript}`,
      );
      await expect
        .poll(async () => {
          const recordings = await readRecordings(page);
          return recordings.find((recording) => recording.status === "completed");
        })
        .toMatchObject({
          surface: "composer",
          transcript: streaming ? streamingTranscript : bufferedTranscript,
          diagnostics: { transport: streaming ? "websocket" : "buffered" },
        });
      const state = await page.evaluate(
        () =>
          window.api!.invoke("codex:dictation:state:read") as Promise<CodexDictationStateSnapshot>,
      );
      expect(state.capabilities.microphoneOwner).toBe("none");
      const http = await readDictationPolicyHttpEvidence(harness.application);
      expect(http.invalidRequests).toEqual([]);
      expect(http.bootstrapRequests).toBeGreaterThan(0);
      expect(http.settingsRequests).toBe(0);
      expect(http.transcriptionBytes).toHaveLength(streaming ? 0 : 1);
      expect(service.invalidMessages).toEqual([]);
      expect(service.sessions).toBe(streaming ? 2 : 0);
      if (streaming) {
        expect(service.completed).toBe(1);
        expect(service.nonzeroAudio).toBe(true);
        expect(service.bytes).toBeGreaterThan(4096);
        await expect.poll(() => streamEvidence.closed).toBe(2);
      }
      await writeFile(
        testInfo.outputPath(`${mode}-evidence.json`),
        JSON.stringify({ http, service }, null, 2),
      );
      await page.screenshot({ path: testInfo.outputPath(`${mode}-completed.png`), fullPage: true });
    } finally {
      try {
        const cancel = harness.page.getByRole("button", { name: "Cancel dictation", exact: true });
        if (await cancel.isVisible()) await cancel.click();
        else if (
          await harness.page
            .getByRole("button", { name: "Stop dictation", exact: true })
            .isVisible()
        ) {
          await harness.page.locator('[data-codex-composer="true"]').press("Escape");
        }
        await writeFile(
          testInfo.outputPath(`${mode}-runtime-evidence.json`),
          JSON.stringify(
            {
              http: await readDictationPolicyHttpEvidence(harness.application),
              recordings: await readRecordings(harness.page),
              service,
              rendererErrors,
            },
            null,
            2,
          ),
        );
      } finally {
        await harness.close();
      }
    }
  }
});
