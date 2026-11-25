import { expect, it, describe, test } from "vite-plus/test";
import { DictationDiagnosticsSchema, serializeDictationDiagnostics } from "./dictation-diagnostics";
import { dictationDiagnosticsFixture } from "../../tests/fixtures/dictation-diagnostics";
import {
  DICTATION_HISTORY_MAX_AUDIO_BYTES,
  DICTATION_HISTORY_MAX_CHUNKS,
  DICTATION_HISTORY_MAX_TRANSCRIPT_BYTES,
  DictationRecordingMetadataSchema,
} from "./dictation-history";
import {
  DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES,
  applyDictationStreamingServerEvent,
  buildDictationStreamingSessionStartMessage,
  createDictationStreamingTranscriptState,
  parseDictationStreamingServerEvent,
  readDictationStreamingFinalText,
} from "./dictation-streaming";

describe("dictation diagnostics", () => {
  it("exports only the bounded diagnostics contract", () => {
    const diagnostics = dictationDiagnosticsFixture();
    expect(JSON.parse(serializeDictationDiagnostics(diagnostics))).toEqual(diagnostics);
    expect(() =>
      serializeDictationDiagnostics({
        ...diagnostics,
        transcript: "private text",
      } as typeof diagnostics),
    ).toThrow();
    expect(
      DictationDiagnosticsSchema.safeParse({
        ...diagnostics,
        streaming: { ...diagnostics.streaming, protocols: ["openai-bearer.secret"] },
      }).success,
    ).toBe(false);
    expect(
      DictationDiagnosticsSchema.safeParse({
        ...diagnostics,
        requests: [{ ...diagnostics.requests[0], headers: { authorization: "secret" } }],
      }).success,
    ).toBe(false);
  });

  it("rejects non-finite, negative and unbounded diagnostic data", () => {
    const diagnostics = dictationDiagnosticsFixture();
    for (const stopToTextMs of [Number.NaN, Infinity, -1]) {
      expect(DictationDiagnosticsSchema.safeParse({ ...diagnostics, stopToTextMs }).success).toBe(
        false,
      );
    }
    expect(
      DictationDiagnosticsSchema.safeParse({
        ...diagnostics,
        phases: Array(13).fill(diagnostics.phases[0]),
      }).success,
    ).toBe(false);
  });

  it.each([
    { skipReason: "unavailable" },
    { skipReason: "unknown" },
    { skipReason: "language-selected" },
    { failureCode: "capability-read-failed" },
  ] as const)(
    "exports a closed reason for an unattempted stream ($skipReason $failureCode)",
    (reason) => {
      const diagnostics = dictationDiagnosticsFixture();
      const report = {
        ...diagnostics,
        streaming: { ...diagnostics.streaming!, attempted: false, opened: false, ...reason },
      };
      expect(JSON.parse(serializeDictationDiagnostics(report))).toEqual(report);
      expect(
        DictationDiagnosticsSchema.safeParse({
          ...report,
          streaming: { ...report.streaming, skipReason: "private error or account data" },
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    "backpressure-overflow",
    "invalid-audio-frame",
    "connect-info-failed",
    "invalid-connect-info",
    "start-timeout",
  ])("keeps saved %s diagnostics readable after transport changes", (failureCode) => {
    const diagnostics = dictationDiagnosticsFixture();
    const saved = { ...diagnostics, streaming: { ...diagnostics.streaming, failureCode } };
    expect(DictationDiagnosticsSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it("retains selected desktop headers, proxy strategy, and classified handshake rejection evidence", () => {
    const diagnostics = dictationDiagnosticsFixture();
    const rejected = {
      ...diagnostics,
      streaming: {
        ...diagnostics.streaming!,
        opened: false,
        started: false,
        failureCode: "edge-challenge" as const,
        httpStatus: 403,
        edgeChallenge: "cloudflare" as const,
        networkError: "proxy" as const,
        proxyMode: "http" as const,
        headers: {
          originator: "Codex Desktop",
          userAgent: "Codex Desktop/test (Mac OS; arm64)",
          authorizationPresent: true,
          accountHeaderPresent: true,
        },
      },
    };
    expect(JSON.parse(serializeDictationDiagnostics(rejected))).toEqual(rejected);
    for (const streaming of [
      { ...rejected.streaming, httpStatus: 600 },
      { ...rejected.streaming, networkError: "ECONNRESET private endpoint" },
      { ...rejected.streaming, edgeChallenge: "<html>private response</html>" },
      { ...rejected.streaming, websocketUrl: "wss://private.example/account" },
      {
        ...rejected.streaming,
        headers: { ...rejected.streaming.headers, authorization: "Bearer secret" },
      },
      {
        ...rejected.streaming,
        headers: { ...rejected.streaming.headers, accountId: "private-account" },
      },
    ]) {
      expect(DictationDiagnosticsSchema.safeParse({ ...rejected, streaming }).success).toBe(false);
    }
  });
});

describe("dictation history", () => {
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
        DictationRecordingMetadataSchema.safeParse({ ...VALID_METADATA, id: "../../escape" })
          .success,
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
});

describe("dictation streaming", () => {
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

    test("adds explicitly supplied session identity, attempt identity, and language to the wire payload", () => {
      expect(
        buildDictationStreamingSessionStartMessage(24_000, true, {
          dictationSessionId: "capture-id",
          attemptId: "attempt-id",
          language: "zh",
        }),
      ).toMatchObject({
        type: "session.start",
        dictation_session_id: "capture-id",
        attempt_id: "attempt-id",
        config: { language: "zh", sample_rate_hz: 24_000, transcript_delivery_mode: "segment" },
      });
      const optional = buildDictationStreamingSessionStartMessage(48_000, false, {
        dictationSessionId: undefined,
        attemptId: undefined,
        language: undefined,
      });
      expect(optional).not.toHaveProperty("dictation_session_id");
      expect(optional).not.toHaveProperty("attempt_id");
      expect(optional.config).not.toHaveProperty("language");
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

  test("accepts numeric wire metadata without coercion and rejects non-finite metadata", () => {
    const event = {
      type: "transcript.segment",
      sequence_no: 1.5,
      utterance_id: "u",
      revision: 2.5,
      text: "text",
    };
    expect(parseDictationStreamingServerEvent(JSON.stringify(event))).toEqual(event);
    for (const sequence_no of ["1", null, false]) {
      expect(
        parseDictationStreamingServerEvent(JSON.stringify({ ...event, sequence_no })),
      ).toBeNull();
    }
    expect(
      parseDictationStreamingServerEvent('{"type":"asset.ready","sequence_no":1e999}'),
    ).toBeNull();
  });
});
