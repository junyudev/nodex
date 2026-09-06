export const DICTATION_STREAM_START_TIMEOUT_MS = 10_000;
export const DICTATION_STREAM_FINISH_TIMEOUT_MS = 8_000;
export const DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES = 4_194_304 as const;
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
    readonly transcript_delivery_mode: "final_only" | "segment";
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
  "empty-final",
  "send-failed",
] as const;
export type DictationStreamingFailureCode = (typeof DICTATION_STREAMING_FAILURE_CODES)[number];

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
      readonly type: "asset.ready" | "asset.committed" | "asset.failed";
      readonly sequence_no: number;
    }
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

export type DictationStreamingTranscriptState = Map<
  string,
  {
    partial: { revision: number; text: string } | null;
    final: { revision: number; text: string } | null;
  }
>;

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
  receiveSegments = false,
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
      transcript_delivery_mode: receiveSegments ? "segment" : "final_only",
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
    case "asset.ready":
    case "asset.committed":
    case "asset.failed":
      return { type: parsed.type, sequence_no: parsed.sequence_no };
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
  return new Map();
}

/** Keep first-observed utterance order and never let an older revision replace newer text. */
export function applyDictationStreamingServerEvent(
  state: DictationStreamingTranscriptState,
  event: DictationStreamingServerEvent,
): void {
  if (
    !("utterance_id" in event) ||
    event.utterance_id == null ||
    event.type === "transcript.delta" ||
    event.type === "transcript.failed"
  )
    return;
  let utterance = state.get(event.utterance_id);
  if (!utterance) {
    utterance = { partial: null, final: null };
    state.set(event.utterance_id, utterance);
  }
  if (event.type === "transcript.final" && event.revision >= (utterance.final?.revision ?? 0)) {
    utterance.final = { revision: event.revision, text: event.text };
    utterance.partial = null;
    return;
  }
  if (
    event.type === "transcript.segment" &&
    !utterance.final &&
    event.revision >= (utterance.partial?.revision ?? 0)
  ) {
    utterance.partial = { revision: event.revision, text: event.text };
  }
}

export function readDictationStreamingFinalText(
  state: DictationStreamingTranscriptState,
  includeSegments = false,
): string {
  return Array.from(
    state.values(),
    (utterance) =>
      utterance.final?.text ?? (includeSegments ? utterance.partial?.text : null) ?? "",
  )
    .filter((text) => text.length > 0)
    .join(" ")
    .trim();
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
