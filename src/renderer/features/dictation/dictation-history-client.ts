import {
  appendDictationRecording,
  createDictationRecording,
  finalizeDictationRecording,
  setDictationRecordingTranscript,
  setDictationRecordingDiagnostics,
} from "@/lib/api";
import type {
  DictationRecordingAppendInput,
  DictationRecordingCreateInput,
  DictationRecordingFinalizeInput,
  DictationRecordingSetTranscriptInput,
  DictationRecordingSetDiagnosticsInput,
} from "../../../shared/dictation-history";
import type { DictationControllerPorts } from "./dictation-session-controller";

interface DictationHistoryTransport {
  create(input: DictationRecordingCreateInput): Promise<unknown>;
  append(input: DictationRecordingAppendInput): Promise<unknown>;
  finalize(input: DictationRecordingFinalizeInput): Promise<unknown>;
  setDiagnostics(input: DictationRecordingSetDiagnosticsInput): Promise<unknown>;
  setTranscript(input: DictationRecordingSetTranscriptInput): Promise<unknown>;
}

export const createDictationHistoryPort = (
  transport: DictationHistoryTransport,
): DictationControllerPorts["history"] => {
  const appendWithOneRetry = async (sessionId: string, chunk: Blob): Promise<void> => {
    const input = { id: sessionId, chunk: new Uint8Array(await chunk.arrayBuffer()) };
    try {
      await transport.append(input);
    } catch {
      await transport.append(input);
    }
  };

  return {
    diagnostics: async (sessionId, diagnostics) => {
      await transport.setDiagnostics({ id: sessionId, diagnostics });
    },
    create: async ({ sessionId, surface, mimeType }) => {
      await transport.create({
        id: sessionId,
        surface,
        mimeType: mimeType || "audio/webm",
      });
    },
    append: appendWithOneRetry,
    finalize: async ({ sessionId, status, durationMs, transcript }) => {
      await transport.finalize({ id: sessionId, status, durationMs: Math.round(durationMs) });
      if (transcript !== undefined) {
        await transport.setTranscript({ id: sessionId, transcript });
      }
    },
  };
};

export const mainDictationHistoryPort = createDictationHistoryPort({
  create: createDictationRecording,
  append: appendDictationRecording,
  finalize: finalizeDictationRecording,
  setTranscript: setDictationRecordingTranscript,
  setDiagnostics: setDictationRecordingDiagnostics,
});
