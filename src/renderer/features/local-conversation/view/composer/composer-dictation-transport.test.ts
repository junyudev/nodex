import { dictationTextResult } from "../../../../../../tests/fixtures/dictation-diagnostics";
import { describe, expect, test } from "vite-plus/test";
import {
  buildDictationMultipartPayload,
  encodeDictationBase64,
  sanitizeDictationFilename,
  transcribeDictationBlob,
} from "./composer-dictation-transport";

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
