import type { DictationStreamDiagnostics } from "./dictation-diagnostics";
export const DICTATION_STREAM_START_TIMEOUT_MS = 10_000;
export const DICTATION_STREAM_FINISH_TIMEOUT_MS = 8_000;
export const DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES = 4_194_304 as const;
export const DICTATION_STREAMING_PORT_CHANNEL = "codex:dictation:streaming:port" as const;
export const DICTATION_STREAMING_WINDOW_MESSAGE = "nodex:dictation:streaming:port" as const;

export interface DictationStreamingPortHandshake {
  readonly type: typeof DICTATION_STREAMING_WINDOW_MESSAGE;
  readonly sessionId: string;
  readonly sampleRateHz: number;
}

export function isDictationStreamingPortHandshake(
  input: unknown,
): input is DictationStreamingPortHandshake {
  if (!input || typeof input !== "object") return false;
  const value = input as Partial<DictationStreamingPortHandshake>;
  return (
    value.type === DICTATION_STREAMING_WINDOW_MESSAGE &&
    typeof value.sessionId === "string" &&
    /^[0-9a-f-]{36}$/iu.test(value.sessionId) &&
    typeof value.sampleRateHz === "number" &&
    Number.isFinite(value.sampleRateHz) &&
    value.sampleRateHz >= 8_000 &&
    value.sampleRateHz <= 192_000
  );
}

export interface DictationStreamingConnectInfo {
  readonly websocketUrl: string;
  readonly protocols: readonly string[];
}

export interface ValidatedDictationStreamingConnectInfo {
  readonly websocketUrl: string;
  readonly protocols: readonly string[];
}

export type DictationStreamingConnectInfoValidation =
  | { readonly ok: true; readonly value: ValidatedDictationStreamingConnectInfo }
  | { readonly ok: false; readonly reason: string };

export interface DictationStreamingSessionStartMessage {
  readonly type: "session.start";
  readonly config: {
    readonly input_audio_format: "pcm16";
    readonly sample_rate_hz: number;
    readonly num_channels: 1;
    readonly max_buffer_size_bytes: 4_194_304;
    readonly max_utterance_duration_ms: 30_000;
    readonly session_ttl_ms: 300_000;
    readonly provider_mode: "streaming_sse";
    readonly transcript_delivery_mode: "final_only";
    readonly vad: {
      readonly type: "server_vad";
      readonly threshold: 0.5;
      readonly prefix_padding_ms: 300;
      readonly silence_duration_ms: 500;
    };
  };
}

export interface DictationStreamingAudioAppendMessage {
  readonly type: "audio.append";
  readonly audio: string;
}

export interface DictationStreamingSessionCloseMessage {
  readonly type: "session.close";
}

export type DictationStreamingClientMessage =
  | {
      readonly type: "audio-frame";
      readonly sequence: number;
      readonly pcm16: ArrayBuffer;
    }
  | { readonly type: "finish" }
  | { readonly type: "abort" };

export const DICTATION_STREAMING_FAILURE_CODES = [
  "connect-info-failed",
  "invalid-connect-info",
  "start-timeout",
  "websocket-failed",
  "invalid-server-event",
  "transcript-failed",
  "fatal-session-error",
  "closed-before-start",
  "unexpected-close",
  "abnormal-close",
  "finish-timeout",
  "backpressure-overflow",
  "invalid-audio-frame",
  "empty-final",
  "send-failed",
] as const;
export type DictationStreamingFailureCode = (typeof DICTATION_STREAMING_FAILURE_CODES)[number];

export interface DictationStreamingFailure {
  readonly code: DictationStreamingFailureCode;
  readonly message: string;
  /** Streaming failures are recoverable by the record-always buffered path. */
  readonly shouldFallback: true;
}

export type DictationStreamingClosedOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "failed" }
  | { readonly kind: "aborted"; readonly shouldFallback: false };

export type DictationStreamingHostMessage =
  | { readonly type: "diagnostics"; readonly diagnostics: DictationStreamDiagnostics }
  | { readonly type: "prepared" }
  | { readonly type: "started" }
  | {
      readonly type: "audio-ack";
      readonly sequence: number;
      readonly byteLength: number;
      readonly outstandingBytes: number;
    }
  | { readonly type: "final"; readonly text: string }
  | { readonly type: "failed"; readonly error: DictationStreamingFailure }
  | { readonly type: "closed"; readonly outcome: DictationStreamingClosedOutcome };

/**
 * Adapter around a dedicated MessagePort. Electron ownership and sender validation stay in the
 * transport adapter; the streaming session only sees its typed, one-session channel.
 */
export interface DictationStreamingPort {
  readonly postMessage: (
    message: DictationStreamingHostMessage,
    transfer?: readonly ArrayBuffer[],
  ) => void;
  readonly onMessage: (listener: (message: DictationStreamingClientMessage) => void) => () => void;
  readonly close: () => void;
}

export interface DictationStreamingServerError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface DictationStreamingServerSession {
  readonly session_id: string;
  readonly status: "active" | "closed";
  readonly config: {
    readonly provider_mode: "buffered" | "streaming_sse";
    readonly transcript_delivery_mode: "final_only" | "segment" | "delta";
  };
}

export type DictationStreamingServerEvent =
  | {
      readonly type: "session.started" | "session.updated";
      readonly sequence_no: number;
      readonly session: DictationStreamingServerSession;
    }
  | {
      readonly type: "speech.started" | "speech.stopped";
      readonly sequence_no: number;
      readonly utterance_id: string;
    }
  | {
      readonly type: "transcript.delta" | "transcript.segment" | "transcript.final";
      readonly sequence_no: number;
      readonly utterance_id: string;
      readonly revision: number;
      readonly text: string;
    }
  | {
      readonly type: "transcript.failed";
      readonly sequence_no: number;
      readonly utterance_id?: string | null;
      readonly error: DictationStreamingServerError;
    }
  | {
      readonly type: "session.error";
      readonly sequence_no: number;
      readonly fatal: boolean;
      readonly error: DictationStreamingServerError;
    };

export interface DictationStreamingTranscriptState {
  readonly orderedUtteranceIds: string[];
  readonly finalTextByUtteranceId: Record<string, string>;
}

const WEBSOCKET_SUBPROTOCOL_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function validateDictationStreamingConnectInfo(
  input: DictationStreamingConnectInfo,
): DictationStreamingConnectInfoValidation {
  let websocketUrl: URL;
  try {
    websocketUrl = new URL(input.websocketUrl);
  } catch {
    return { ok: false, reason: "The streaming endpoint is not a valid URL." };
  }

  if (websocketUrl.protocol !== "wss:" || websocketUrl.host.length === 0) {
    return { ok: false, reason: "The streaming endpoint must use wss with a host." };
  }
  if (
    websocketUrl.username.length > 0 ||
    websocketUrl.password.length > 0 ||
    websocketUrl.hash.length > 0
  ) {
    return { ok: false, reason: "The streaming endpoint must not contain credentials or a hash." };
  }
  if (!Array.isArray(input.protocols)) {
    return { ok: false, reason: "The streaming endpoint must return a subprotocol array." };
  }

  const protocols = [...input.protocols];
  if (protocols.some((protocol) => !WEBSOCKET_SUBPROTOCOL_PATTERN.test(protocol))) {
    return { ok: false, reason: "The streaming endpoint returned an invalid subprotocol." };
  }
  if (new Set(protocols).size !== protocols.length) {
    return { ok: false, reason: "The streaming endpoint returned duplicate subprotocols." };
  }

  return {
    ok: true,
    value: {
      websocketUrl: websocketUrl.toString(),
      protocols,
    },
  };
}

export function buildDictationStreamingSessionStartMessage(
  sampleRateHz: number,
): DictationStreamingSessionStartMessage {
  return {
    type: "session.start",
    config: {
      input_audio_format: "pcm16",
      sample_rate_hz: sampleRateHz,
      num_channels: 1,
      max_buffer_size_bytes: DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES,
      max_utterance_duration_ms: 30_000,
      session_ttl_ms: 300_000,
      provider_mode: "streaming_sse",
      transcript_delivery_mode: "final_only",
      vad: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    },
  };
}

export function parseDictationStreamingServerEvent(
  payload: unknown,
): DictationStreamingServerEvent | null {
  if (typeof payload !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    !isSequenceNumber(parsed.sequence_no) ||
    typeof parsed.type !== "string"
  ) {
    return null;
  }

  switch (parsed.type) {
    case "session.started":
    case "session.updated": {
      const session = parseServerSession(parsed.session);
      if (session === null) return null;
      return { type: parsed.type, sequence_no: parsed.sequence_no, session };
    }
    case "speech.started":
    case "speech.stopped":
      if (typeof parsed.utterance_id !== "string") return null;
      return {
        type: parsed.type,
        sequence_no: parsed.sequence_no,
        utterance_id: parsed.utterance_id,
      };
    case "transcript.delta":
    case "transcript.segment":
    case "transcript.final":
      if (
        typeof parsed.utterance_id !== "string" ||
        !isSequenceNumber(parsed.revision) ||
        typeof parsed.text !== "string"
      ) {
        return null;
      }
      return {
        type: parsed.type,
        sequence_no: parsed.sequence_no,
        utterance_id: parsed.utterance_id,
        revision: parsed.revision,
        text: parsed.text,
      };
    case "transcript.failed": {
      const error = parseServerError(parsed.error);
      if (error === null) return null;
      if (
        parsed.utterance_id !== undefined &&
        parsed.utterance_id !== null &&
        typeof parsed.utterance_id !== "string"
      ) {
        return null;
      }
      return {
        type: parsed.type,
        sequence_no: parsed.sequence_no,
        utterance_id: parsed.utterance_id,
        error,
      };
    }
    case "session.error": {
      const error = parseServerError(parsed.error);
      if (error === null || typeof parsed.fatal !== "boolean") return null;
      return {
        type: parsed.type,
        sequence_no: parsed.sequence_no,
        fatal: parsed.fatal,
        error,
      };
    }
    default:
      return null;
  }
}

export function createDictationStreamingTranscriptState(): DictationStreamingTranscriptState {
  return {
    orderedUtteranceIds: [],
    finalTextByUtteranceId: Object.create(null) as Record<string, string>,
  };
}

/** Final text follows first-observed utterance order, matching the server VAD event stream. */
export function applyDictationStreamingServerEvent(
  state: DictationStreamingTranscriptState,
  event: DictationStreamingServerEvent,
): void {
  switch (event.type) {
    case "speech.started":
    case "speech.stopped":
      ensureUtterance(state, event.utterance_id);
      return;
    case "transcript.final":
      ensureUtterance(state, event.utterance_id);
      state.finalTextByUtteranceId[event.utterance_id] = event.text;
      return;
    default:
      return;
  }
}

export function readDictationStreamingFinalText(state: DictationStreamingTranscriptState): string {
  return state.orderedUtteranceIds
    .map((utteranceId) => state.finalTextByUtteranceId[utteranceId] ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function ensureUtterance(state: DictationStreamingTranscriptState, utteranceId: string): void {
  if (Object.hasOwn(state.finalTextByUtteranceId, utteranceId)) return;
  state.finalTextByUtteranceId[utteranceId] = "";
  state.orderedUtteranceIds.push(utteranceId);
}

function parseServerSession(value: unknown): DictationStreamingServerSession | null {
  if (!isRecord(value) || !isRecord(value.config)) return null;
  if (typeof value.session_id !== "string") return null;
  if (value.status !== "active" && value.status !== "closed") return null;
  if (value.config.provider_mode !== "buffered" && value.config.provider_mode !== "streaming_sse") {
    return null;
  }
  if (
    value.config.transcript_delivery_mode !== "final_only" &&
    value.config.transcript_delivery_mode !== "segment" &&
    value.config.transcript_delivery_mode !== "delta"
  ) {
    return null;
  }
  return {
    session_id: value.session_id,
    status: value.status,
    config: {
      provider_mode: value.config.provider_mode,
      transcript_delivery_mode: value.config.transcript_delivery_mode,
    },
  };
}

function parseServerError(value: unknown): DictationStreamingServerError | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean"
  ) {
    return null;
  }
  return {
    code: value.code,
    message: value.message,
    retryable: value.retryable,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequenceNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
