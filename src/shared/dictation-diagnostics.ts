import { z } from "zod";
import { DICTATION_STREAMING_FAILURE_CODES } from "./dictation-streaming";

const milliseconds = z.number().finite().nonnegative().max(86_400_000);
const count = z.number().int().nonnegative().max(1_000_000_000);

export const DictationStreamDiagnosticsSchema = z
  .object({
    attempted: z.boolean(),
    opened: z.boolean(),
    started: z.boolean(),
    finalReceived: z.boolean(),
    sentAudioBytes: count,
    sentAudioFrames: count,
    transcriptEvents: count,
    connectInfoMs: milliseconds.optional(),
    handshakeMs: milliseconds.optional(),
    sessionStartMs: milliseconds.optional(),
    finishMs: milliseconds.optional(),
    closeCode: z.number().int().min(0).max(65_535).optional(),
    selectedProtocol: z.enum(["chatgpt-dictation", "codex-desktop", "other", "none"]).optional(),
    providerMode: z.enum(["buffered", "streaming_sse"]).optional(),
    failureCode: z
      .enum([
        ...DICTATION_STREAMING_FAILURE_CODES,
        // Persisted recordings retain diagnostic outcomes from retired transports.
        "backpressure-overflow",
        "invalid-audio-frame",
        "audio-worklet-failed",
        "audio-start-timeout",
        "audio-flush-timeout",
        "stream-unavailable",
        "aborted",
      ])
      .optional(),
  })
  .strict();

export const DictationHttpDiagnosticsSchema = z
  .object({
    operation: z.enum(["transcription", "cleanup"]),
    requestId: z.string().uuid(),
    endpoint: z.enum(["/transcribe", "/codex/responses"]),
    model: z.literal("gpt-5.6-luna").optional(),
    outcome: z.enum(["completed", "failed", "empty"]),
    status: z.number().int().min(100).max(599).optional(),
    totalMs: milliseconds,
    headersMs: milliseconds.optional(),
    bodyMs: milliseconds.optional(),
    attempts: z.number().int().min(0).max(2),
    responseId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,160}$/u)
      .optional(),
    // Only these explicitly selected headers may leave the request adapter.
    headers: z
      .object({
        originator: z.string().max(160),
        userAgent: z.string().max(256),
        authorizationPresent: z.boolean(),
        accountHeaderPresent: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const DictationPhaseSchema = z
  .object({
    stage: z.enum([
      "permission",
      "microphone",
      "recording",
      "recorder-stop",
      "stream-finalize",
      "buffered",
      "cleanup",
      "history",
      "delivery",
    ]),
    offsetMs: milliseconds,
    durationMs: milliseconds,
    outcome: z.enum(["completed", "failed", "skipped"]),
  })
  .strict();

/** One bounded attempt, with no audio, text, URLs, tokens, or raw server errors. */
export const DictationDiagnosticsSchema = z
  .object({
    version: z.literal(1),
    attempt: z.number().int().positive().max(1_000_000),
    source: z.enum(["capture", "retry", "recovery"]),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    transport: z.enum(["websocket", "buffered", "retained", "none"]),
    delivery: z.enum(["composer", "global", "history"]),
    stopOffsetMs: milliseconds.optional(),
    stopToTextMs: milliseconds.optional(),
    stopToCompletionMs: milliseconds.optional(),
    clipboardRestoreMs: milliseconds.optional(),
    phases: z.array(DictationPhaseSchema).max(12),
    streaming: DictationStreamDiagnosticsSchema.optional(),
    requests: z.array(DictationHttpDiagnosticsSchema).max(2),
  })
  .strict();

export type DictationStreamDiagnostics = z.infer<typeof DictationStreamDiagnosticsSchema>;
export type DictationHttpDiagnostics = z.infer<typeof DictationHttpDiagnosticsSchema>;
export type DictationDiagnostics = z.infer<typeof DictationDiagnosticsSchema>;
export type DictationPhase = z.infer<typeof DictationPhaseSchema>;

export type DictationTextResult = {
  readonly text: string;
  readonly diagnostics: DictationHttpDiagnostics;
};

export const emptyDictationStreamDiagnostics = (): DictationStreamDiagnostics => ({
  attempted: false,
  opened: false,
  started: false,
  finalReceived: false,
  sentAudioBytes: 0,
  sentAudioFrames: 0,
  transcriptEvents: 0,
});

/** Revalidate the closed contract before export; never serialize a recording or transport object. */
export const serializeDictationDiagnostics = (value: DictationDiagnostics): string =>
  JSON.stringify(DictationDiagnosticsSchema.parse(value), null, 2);
