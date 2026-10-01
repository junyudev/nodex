import { describe, expect, test } from "vite-plus/test";
import {
  DICTATION_HISTORY_MAX_AUDIO_BYTES,
  DICTATION_HISTORY_MAX_CHUNKS,
  DICTATION_HISTORY_MAX_TRANSCRIPT_BYTES,
  DictationRecordingMetadataSchema,
} from "./dictation-history";

const VALID_METADATA = {
  schemaVersion: 1,
  id: "session:8b73e42a-320d-4efb-888a-b1cbf84449e7",
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
  durationMs: 900,
  mimeType: "audio/webm;codecs=opus",
  sizeBytes: 4,
  chunkCount: 1,
  status: "completed",
  surface: "composer",
} as const;

describe("dictation history contract", () => {
  test("strictly accepts the complete metadata contract", () => {
    expect(DictationRecordingMetadataSchema.parse(VALID_METADATA)).toEqual(VALID_METADATA);
    expect(
      DictationRecordingMetadataSchema.safeParse({ ...VALID_METADATA, privatePath: "/tmp/audio" })
        .success,
    ).toBe(false);
  });

  test("rejects unknown statuses, surfaces, unsafe identities, and invalid clocks", () => {
    expect(
      DictationRecordingMetadataSchema.safeParse({ ...VALID_METADATA, status: "failed" }).success,
    ).toBe(false);
    expect(
      DictationRecordingMetadataSchema.safeParse({ ...VALID_METADATA, surface: "settings" })
        .success,
    ).toBe(false);
    expect(
      DictationRecordingMetadataSchema.safeParse({ ...VALID_METADATA, id: "../../escape" }).success,
    ).toBe(false);
    expect(
      DictationRecordingMetadataSchema.safeParse({
        ...VALID_METADATA,
        createdAtMs: 2_001,
        updatedAtMs: 2_000,
      }).success,
    ).toBe(false);
  });

  test("bounds user-growing metadata fields", () => {
    expect(
      DictationRecordingMetadataSchema.safeParse({
        ...VALID_METADATA,
        chunkCount: DICTATION_HISTORY_MAX_CHUNKS + 1,
      }).success,
    ).toBe(false);
    expect(
      DictationRecordingMetadataSchema.safeParse({
        ...VALID_METADATA,
        sizeBytes: DICTATION_HISTORY_MAX_AUDIO_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      DictationRecordingMetadataSchema.safeParse({
        ...VALID_METADATA,
        transcript: "a".repeat(DICTATION_HISTORY_MAX_TRANSCRIPT_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  test("keeps imported file identity separate from microphone capture", () => {
    const imported = { ...VALID_METADATA, surface: "file", fileName: "Interview.webm" };
    expect(DictationRecordingMetadataSchema.parse(imported)).toEqual(imported);
    expect(
      DictationRecordingMetadataSchema.safeParse({ ...VALID_METADATA, surface: "file" }).success,
    ).toBe(false);
    expect(
      DictationRecordingMetadataSchema.safeParse({ ...VALID_METADATA, fileName: "capture.webm" })
        .success,
    ).toBe(false);
    for (const fileName of [
      "",
      "../audio.webm",
      "folder\\audio.webm",
      "audio\n.webm",
      "a".repeat(256),
    ]) {
      expect(DictationRecordingMetadataSchema.safeParse({ ...imported, fileName }).success).toBe(
        false,
      );
    }
  });
});
