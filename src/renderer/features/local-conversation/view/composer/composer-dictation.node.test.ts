import { dictationTextResult } from "../../../../../../tests/fixtures/dictation-diagnostics";
import { createTextareaDictationTarget } from "@/features/dictation/textarea-dictation-target";
import { describe, expect, test } from "vite-plus/test";
import {
  buildDictationMultipartPayload,
  encodeDictationBase64,
  sanitizeDictationFilename,
  transcribeDictationBlob,
} from "./composer-dictation-transport";
import {
  COMPOSER_DICTATION_WAVEFORM_ADVANCE_INTERVAL_MS,
  COMPOSER_DICTATION_WAVEFORM_SAMPLE_FLOOR,
  appendComposerDictationWaveformLevel,
  normalizeComposerDictationRms,
  resolveComposerDictationWaveformGeometry,
} from "./composer-dictation-waveform";

describe("composer dictation transport", () => {
  test("sanitizes quoted filenames", () => {
    expect(sanitizeDictationFilename('co"dex".webm')).toBe("codex.webm");
  });

  test("builds the Codex multipart payload shape", async () => {
    const payload = await buildDictationMultipartPayload({
      blob: new Blob(["audio-bytes"], { type: "audio/webm" }),
      boundary: "----codex-transcribe-test",
      filename: "codex.webm",
      contentType: "audio/webm",
      language: "en",
    });

    const bodyText = new TextDecoder().decode(payload);
    expect(
      Boolean(
        bodyText.includes('Content-Disposition: form-data; name="file"; filename="codex.webm"'),
      ),
    ).toBe(true);
    expect(Boolean(bodyText.includes("Content-Type: audio/webm"))).toBe(true);
    expect(Boolean(bodyText.includes('Content-Disposition: form-data; name="language"'))).toBe(
      true,
    );
    expect(Boolean(bodyText.includes("audio-bytes"))).toBe(true);
  });

  test("sends a base64-wrapped multipart payload through the typed bridge", async () => {
    let capturedInput: {
      contentType: string;
      base64Payload: string;
    } | null = null;
    const text = await transcribeDictationBlob(new Blob(["audio-bytes"], { type: "audio/webm" }), {
      transcribe: async (input) => {
        capturedInput = input;
        return dictationTextResult("transcribed text");
      },
    });

    const input = capturedInput as unknown as {
      contentType: string;
      base64Payload: string;
    };
    expect(text).toBe("transcribed text");
    expect(input.contentType.startsWith("multipart/form-data; boundary=")).toBe(true);
    expect(input.base64Payload.length > 0).toBe(true);

    const decoded = atob(input.base64Payload);
    expect(
      Boolean(
        decoded.includes('Content-Disposition: form-data; name="file"; filename="codex.webm"'),
      ),
    ).toBe(true);
  });

  test("encodes bytes using the same chunked base64 strategy", () => {
    const encoded = encodeDictationBase64(new Uint8Array([99, 111, 100, 101, 120]));
    expect(encoded).toBe("Y29kZXg=");
  });
});

describe("composer dictation waveform", () => {
  test("uses the reference three-pixel bars and fixed 30px/s advance", () => {
    const geometry = resolveComposerDictationWaveformGeometry(574);

    expect(geometry).toEqual({
      barCount: 96,
      barPitchPx: 6,
      barWidthPx: 3,
      historyDurationMs: 19_200,
      scrollSpeedPxPerSecond: 30,
    });
    expect(COMPOSER_DICTATION_WAVEFORM_ADVANCE_INTERVAL_MS).toBe(200);
  });

  test("applies the noise gate and reference nonlinear response", () => {
    expect(normalizeComposerDictationRms(0)).toBe(0);
    expect(normalizeComposerDictationRms(0.006)).toBe(0);
    expect(normalizeComposerDictationRms(0.16)).toBe(1);
    expect(normalizeComposerDictationRms(0.05)).toBeCloseTo(0.4717, 3);
  });

  test("advances one history level at a time and evicts the oldest", () => {
    const levels = [COMPOSER_DICTATION_WAVEFORM_SAMPLE_FLOOR, 0.2];

    appendComposerDictationWaveformLevel(levels, 0.16, 2);

    expect(levels).toEqual([0.2, 1]);
  });
});

describe("textarea dictation", () => {
  test("replaces the selection with word boundaries and keeps surrounding whitespace", () => {
    const target = createTextareaDictationTarget(() => undefined);
    target.observe("Please(old)  tomorrow", { from: 7, to: 10 });
    target.insert("  call home  ");
    expect(target.text).toBe("Please(call home)  tomorrow");

    target.observe("speaknow", { from: 5, to: 5 });
    target.insert(" clearly ");
    expect(target.text).toBe("speak clearly now");
  });

  test("updates earlier segments at their anchored ranges and cancels only untouched text", () => {
    const target = createTextareaDictationTarget(() => undefined);
    target.observe("Alpha old Omega", { from: 6, to: 9 });
    let segment = 0;
    target.start(() => ++segment);
    target.update("one", { id: 0, text: "one" });
    target.observe(target.text, { from: target.text.length, to: target.text.length });
    target.update("one two", { id: 0, text: "one two" });
    target.update("three", { id: 1, text: "three" });
    expect(target.text).toBe("Alpha one two Omega three");

    target.observe("Alpha one too Omega three", { from: 13, to: 13 });
    target.update("one two revised", { id: 0, text: "one two revised" });
    expect(target.text).toBe("Alpha one too Omega three");

    target.cancel();
    expect(target.text).toBe("Alpha one too Omega");
  });

  test("restores a selection replaced by more than one provisional segment", () => {
    const target = createTextareaDictationTarget(() => undefined);
    target.observe("Alpha old Omega", { from: 6, to: 9 });
    target.start(() => 1);
    target.update("one two", { id: 0, text: "one two" });
    target.observe(target.text, { from: 6, to: 13 });
    target.update("new", { id: 1, text: "new" });
    expect(target.text).toBe("Alpha new Omega");
    target.cancel();
    expect(target.text).toBe("Alpha old Omega");
  });

  test("defers transcript revisions until composition finishes", async () => {
    const target = createTextareaDictationTarget(() => undefined);
    target.observe("draft ", { from: 6, to: 6 });
    target.start(() => null);
    target.beginComposition();
    target.update("provisional", { id: 0, text: "provisional" });
    const finished = target.finish("final");
    expect(target.text).toBe("draft ");
    target.finishComposition();
    expect(await finished).toBe("finished");
    expect(target.text).toBe("draft final");
  });
});
