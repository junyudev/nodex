import { DictationDiagnosticsSchema, type DictationDiagnostics } from "./dictation-diagnostics";
import { z } from "zod";
import type { DictationSurface } from "./dictation";

export const DICTATION_HISTORY_DIRECTORY_NAME = "dictation-history";
export const DICTATION_RECORDING_SCHEMA_VERSION = 1 as const;
export const DICTATION_HISTORY_MAX_RECORDINGS = 20;
export const DICTATION_HISTORY_MAX_CHUNKS = 512;
export const DICTATION_HISTORY_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const DICTATION_HISTORY_MAX_AUDIO_BYTES = 64 * 1024 * 1024;
// JSON escaping can expand some transcript characters to six bytes on disk.
export const DICTATION_HISTORY_MAX_METADATA_BYTES = 512 * 1024;
export const DICTATION_HISTORY_MAX_TRANSCRIPT_BYTES = 64 * 1024;

const DICTATION_RECORDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DICTATION_AUDIO_MIME_TYPE = /^audio\/[\x21-\x7e]+$/u;

export const DictationRecordingIdSchema = z.string().regex(DICTATION_RECORDING_ID);
export const DictationRecordingStatusSchema = z.enum([
  "recording",
  "completed",
  "cancelled",
  "interrupted",
]);
export const DictationRecordingSurfaceSchema = z.enum(["composer", "global"]);
export const DictationRecordingMimeTypeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(DICTATION_AUDIO_MIME_TYPE);

const DictationTranscriptSchema = z
  .string()
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= DICTATION_HISTORY_MAX_TRANSCRIPT_BYTES,
    `Transcript must be at most ${DICTATION_HISTORY_MAX_TRANSCRIPT_BYTES} UTF-8 bytes`,
  );

export const DictationRecordingMetadataSchema = z
  .object({
    schemaVersion: z.literal(DICTATION_RECORDING_SCHEMA_VERSION),
    id: DictationRecordingIdSchema,
    createdAtMs: z.number().int().nonnegative().safe(),
    updatedAtMs: z.number().int().nonnegative().safe(),
    durationMs: z.number().int().nonnegative().safe(),
    mimeType: DictationRecordingMimeTypeSchema,
    sizeBytes: z.number().int().nonnegative().max(DICTATION_HISTORY_MAX_AUDIO_BYTES).safe(),
    chunkCount: z.number().int().nonnegative().max(DICTATION_HISTORY_MAX_CHUNKS).safe(),
    status: DictationRecordingStatusSchema,
    surface: DictationRecordingSurfaceSchema,
    transcript: DictationTranscriptSchema.optional(),
    diagnostics: DictationDiagnosticsSchema.optional(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.updatedAtMs < metadata.createdAtMs) {
      context.addIssue({
        code: "custom",
        message: "updatedAtMs must not precede createdAtMs",
        path: ["updatedAtMs"],
      });
    }
  });

export type DictationRecordingStatus = z.infer<typeof DictationRecordingStatusSchema>;
export type DictationRecordingSurface = DictationSurface;
export type DictationRecordingMetadata = z.infer<typeof DictationRecordingMetadataSchema>;

export interface DictationRecordingCreateInput {
  readonly id: string;
  readonly mimeType: string;
  readonly surface: DictationRecordingSurface;
}

export interface DictationRecordingAppendInput {
  readonly id: string;
  readonly chunk: Uint8Array;
}

export interface DictationRecordingFinalizeInput {
  readonly id: string;
  readonly durationMs: number;
  readonly status: Extract<DictationRecordingStatus, "completed" | "cancelled">;
}

export interface DictationRecordingSetTranscriptInput {
  readonly id: string;
  readonly transcript: string | null;
}

export interface DictationRecordingAudio {
  readonly recording: DictationRecordingMetadata;
  readonly bytes: Uint8Array;
}

export interface DictationRecordingSetDiagnosticsInput {
  readonly id: string;
  readonly diagnostics: DictationDiagnostics;
}
