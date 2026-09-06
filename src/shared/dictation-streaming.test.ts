import { describe, expect, test } from "vite-plus/test";
import {
  DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES,
  applyDictationStreamingServerEvent,
  buildDictationStreamingSessionStartMessage,
  createDictationStreamingTranscriptState,
  parseDictationStreamingServerEvent,
  readDictationStreamingFinalText,
  validateDictationStreamingConnectInfo,
} from "./dictation-streaming";

describe("dictation streaming wire contract", () => {
  test("builds the exact Codex session.start configuration", () => {
    expect(buildDictationStreamingSessionStartMessage(48_000)).toEqual({
      type: "session.start",
      config: {
        input_audio_format: "pcm16",
        sample_rate_hz: 48_000,
        num_channels: 1,
        max_buffer_size_bytes: 4_194_304,
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
    });
    expect(DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES).toBe(4_194_304);
  });

  test("accepts only secure, credential-free endpoints and valid unique protocols", () => {
    expect(
      validateDictationStreamingConnectInfo({
        websocketUrl: "wss://example.test/dictation?token=opaque",
        protocols: ["realtime-v1", "openai.beta"],
      }),
    ).toEqual({
      ok: true,
      value: {
        websocketUrl: "wss://example.test/dictation?token=opaque",
        protocols: ["realtime-v1", "openai.beta"],
      },
    });
    expect(
      validateDictationStreamingConnectInfo({
        websocketUrl: "wss://example.test/dictation",
        protocols: [],
      }).ok,
    ).toBe(true);

    for (const input of [
      { websocketUrl: "https://example.test/socket", protocols: ["realtime-v1"] },
      { websocketUrl: "ws://example.test/socket", protocols: ["realtime-v1"] },
      { websocketUrl: "wss://user:secret@example.test/socket", protocols: ["realtime-v1"] },
      { websocketUrl: "wss://example.test/socket#secret", protocols: ["realtime-v1"] },
      { websocketUrl: "wss://example.test/socket", protocols: ["bad protocol"] },
      { websocketUrl: "wss://example.test/socket", protocols: ["same", "same"] },
    ]) {
      expect(validateDictationStreamingConnectInfo(input).ok).toBe(false);
    }
  });

  test("parses every supported server event and rejects partial or unknown payloads", () => {
    const events = [
      {
        type: "session.started",
        sequence_no: 0,
        session: {
          session_id: "server-session",
          status: "active",
          config: { provider_mode: "streaming_sse", transcript_delivery_mode: "final_only" },
        },
      },
      {
        type: "session.updated",
        sequence_no: 1,
        session: {
          session_id: "server-session",
          status: "closed",
          config: { provider_mode: "streaming_sse", transcript_delivery_mode: "final_only" },
        },
      },
      { type: "speech.started", sequence_no: 2, utterance_id: "u1" },
      { type: "speech.stopped", sequence_no: 3, utterance_id: "u1" },
      { type: "transcript.delta", sequence_no: 4, utterance_id: "u1", revision: 1, text: "a" },
      {
        type: "transcript.segment",
        sequence_no: 5,
        utterance_id: "u1",
        revision: 2,
        text: "alpha",
      },
      {
        type: "transcript.final",
        sequence_no: 6,
        utterance_id: "u1",
        revision: 3,
        text: "alpha",
      },
      {
        type: "transcript.failed",
        sequence_no: 7,
        utterance_id: null,
        error: { code: "transcription_failed", message: "failed", retryable: true },
      },
      {
        type: "session.error",
        sequence_no: 8,
        fatal: false,
        error: { code: "warning", message: "warning", retryable: false },
      },
    ] as const;

    for (const event of events) {
      expect(parseDictationStreamingServerEvent(JSON.stringify(event))).toEqual(event);
    }

    expect(parseDictationStreamingServerEvent("not-json")).toBeNull();
    expect(parseDictationStreamingServerEvent(new Uint8Array())).toBeNull();
    expect(
      parseDictationStreamingServerEvent(JSON.stringify({ type: "unknown", sequence_no: 9 })),
    ).toBeNull();
    expect(
      parseDictationStreamingServerEvent(
        JSON.stringify({ type: "transcript.final", sequence_no: 9, utterance_id: "u1" }),
      ),
    ).toBeNull();
  });

  test("orders final text by first-observed utterance and replaces final revisions", () => {
    const state = createDictationStreamingTranscriptState();
    const events = [
      { type: "speech.started", sequence_no: 0, utterance_id: "second" },
      {
        type: "transcript.final",
        sequence_no: 1,
        utterance_id: "first",
        revision: 1,
        text: "world",
      },
      {
        type: "transcript.final",
        sequence_no: 2,
        utterance_id: "second",
        revision: 1,
        text: "hello",
      },
      {
        type: "transcript.final",
        sequence_no: 3,
        utterance_id: "first",
        revision: 2,
        text: "world!",
      },
    ] as const;

    for (const rawEvent of events) {
      const event = parseDictationStreamingServerEvent(JSON.stringify(rawEvent));
      expect(event).not.toBeNull();
      if (event !== null) applyDictationStreamingServerEvent(state, event);
    }

    expect(readDictationStreamingFinalText(state)).toBe("hello world!");
  });
});

test("retains newest final revisions, ignores later segments, and accepts asset lifecycle events", () => {
  const state = createDictationStreamingTranscriptState();
  const event = {
    type: "transcript.final",
    sequence_no: 1,
    utterance_id: "u",
    revision: 2,
    text: "new",
  } as const;
  applyDictationStreamingServerEvent(state, event);
  applyDictationStreamingServerEvent(state, { ...event, revision: 1, text: "old" });
  applyDictationStreamingServerEvent(state, {
    ...event,
    type: "transcript.segment",
    revision: 3,
    text: "partial",
  });
  expect(readDictationStreamingFinalText(state, true)).toBe("new");
  for (const type of ["asset.ready", "asset.committed", "asset.failed"]) {
    expect(parseDictationStreamingServerEvent(JSON.stringify({ type, sequence_no: 3 }))).toEqual({
      type,
      sequence_no: 3,
    });
  }
});
