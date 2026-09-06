import type { DictationDiagnostics, DictationTextResult } from "../../src/shared/dictation-diagnostics";

export const dictationTextResult = (text: string, operation: "transcription" | "cleanup" = "transcription"): DictationTextResult => ({
  text,
  diagnostics: {
    requestId: "4ee71509-91df-4ebe-adef-9cc41b200af1", operation,
    endpoint: operation === "cleanup" ? "/codex/responses" : "/transcribe",
    ...(operation === "cleanup" ? { model: "gpt-5.6-luna" as const } : {}),
    outcome: "completed", totalMs: 420, headersMs: 300, bodyMs: 120, attempts: 1, status: 200,
  },
});

export const dictationDiagnosticsFixture = (): DictationDiagnostics => ({
  version: 1, attempt: 1, source: "capture", outcome: "completed", transport: "buffered", delivery: "global",
  stopOffsetMs: 12_200, stopToTextMs: 1_340, stopToCompletionMs: 2_040, clipboardRestoreMs: 700,
  phases: [
    { stage: "permission", offsetMs: 0, durationMs: 10, outcome: "completed" },
    { stage: "microphone", offsetMs: 10, durationMs: 190, outcome: "completed" },
    { stage: "recording", offsetMs: 200, durationMs: 12_000, outcome: "completed" },
    { stage: "recorder-stop", offsetMs: 12_200, durationMs: 20, outcome: "completed" },
    { stage: "stream-finalize", offsetMs: 12_220, durationMs: 0, outcome: "completed" },
    { stage: "buffered", offsetMs: 12_220, durationMs: 720, outcome: "completed" },
    { stage: "cleanup", offsetMs: 12_940, durationMs: 420, outcome: "completed" },
    { stage: "history", offsetMs: 13_360, durationMs: 30, outcome: "completed" },
    { stage: "delivery", offsetMs: 13_390, durationMs: 850, outcome: "completed" },
  ],
  streaming: {
    attempted: true, opened: true, started: true, finalReceived: false,
    sentAudioBytes: 32_768, sentAudioFrames: 8, transcriptEvents: 0,
    connectInfoMs: 32, handshakeMs: 180, sessionStartMs: 42,
    closeCode: 1006, failureCode: "abnormal-close", selectedProtocol: "chatgpt-dictation", providerMode: "streaming_sse",
  },
  requests: [
    { ...dictationTextResult("").diagnostics, totalMs: 720, headersMs: 600 },
    { ...dictationTextResult("", "cleanup").diagnostics, requestId: "0158274e-b921-438c-a392-d5b789f67e8b" },
  ],
});
