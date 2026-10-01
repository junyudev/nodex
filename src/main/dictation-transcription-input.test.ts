import { describe, expect, test } from "vite-plus/test";
import { validateDictationTranscriptionInput } from "./dictation-transcription-input";

describe("validateDictationTranscriptionInput", () => {
  test("accepts a bounded base64 multipart envelope and trims its content type", () => {
    expect(
      validateDictationTranscriptionInput({
        contentType: " multipart/form-data; boundary=nodex-test ",
        base64Payload: "YXVkaW8=",
        requestId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toEqual({
      contentType: "multipart/form-data; boundary=nodex-test",
      base64Payload: "YXVkaW8=",
      requestId: "00000000-0000-4000-8000-000000000000",
    });
  });

  test.each([
    null,
    {},
    { contentType: "audio/webm", base64Payload: "YXVkaW8=" },
    { contentType: "multipart/form-data", base64Payload: "YXVkaW8=" },
    { contentType: "multipart/form-data; boundary=x", base64Payload: "" },
    { contentType: "multipart/form-data; boundary=x", base64Payload: "not base64" },
    { contentType: "multipart/form-data; boundary=x", base64Payload: "abc" },
  ])("rejects an invalid envelope: %o", (input) => {
    expect(() => validateDictationTranscriptionInput(input)).toThrow();
  });

  test("enforces the encoded payload byte budget", () => {
    expect(() =>
      validateDictationTranscriptionInput(
        {
          contentType: "multipart/form-data; boundary=x",
          base64Payload: "YXVkaW8=",
          requestId: "00000000-0000-4000-8000-000000000000",
        },
        7,
      ),
    ).toThrow("oversized");
  });

  test("admits retained audio after multipart and Base64 expansion", () => {
    // A 48 MiB recording already expands to 64 MiB before adding multipart headers.
    const base64Payload = "A".repeat(64 * 1024 * 1024 + 1024);
    expect(
      validateDictationTranscriptionInput({
        contentType: "multipart/form-data; boundary=nodex-test",
        base64Payload,
        requestId: "00000000-0000-4000-8000-000000000000",
      }).base64Payload,
    ).toBe(base64Payload);
  });
});
