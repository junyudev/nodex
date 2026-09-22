import { Blob as NodeBlob } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { DictationTextResult } from "../../../shared/dictation-diagnostics";
import { transcribeDictationBlob } from "./dictation-buffered-client";

const audio = (): Blob => new NodeBlob([Uint8Array.of(1, 2)], { type: "audio/webm" }) as Blob;
const result = (text: string, outcome: "completed" | "failed" | "empty"): DictationTextResult => ({
  text,
  diagnostics: {
    operation: "transcription",
    requestId: "e1e824bd-dc1e-42b8-8cb7-a6d3c2b9c94b",
    endpoint: "/transcribe",
    outcome,
    totalMs: 1,
    attempts: 1,
    status: 200,
  },
});

describe("buffered dictation", () => {
  it("sends an explicit language with the captured audio and accepts a silent result", async () => {
    const transcribe = vi.fn(async (_input: { contentType: string; base64Payload: string }) =>
      result("", "empty"),
    );
    await expect(transcribeDictationBlob(audio(), { language: "ja", transcribe })).resolves.toBe(
      "",
    );
    const call = transcribe.mock.calls[0];
    if (!call) throw new Error("Expected an audio request");
    const input = call[0];
    const body = atob(input.base64Payload);
    expect(body).toContain('name="language"\r\n\r\nja\r\n');
    expect(body).toContain("\u0001\u0002");
  });

  it("rejects failed responses instead of treating an empty payload as silence", async () => {
    await expect(
      transcribeDictationBlob(audio(), { transcribe: async () => result("", "failed") }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("never returns a late result after the capture owner cancels", async () => {
    const abort = new AbortController();
    await expect(
      transcribeDictationBlob(audio(), {
        signal: abort.signal,
        transcribe: async () => {
          abort.abort();
          return result("late text", "completed");
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
