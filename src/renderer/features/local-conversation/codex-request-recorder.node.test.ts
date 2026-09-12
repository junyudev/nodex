import { describe, expect, it, vi } from "vitest";
import type {
  CodexRequestLifecycleEvent,
  CodexRequestLifecycleTerminalEvent,
} from "../../../shared/codex-request-lifecycle";
import {
  clearCodexRequestRecords,
  CodexRequestRecorder,
  codexRequestPreview,
  getCodexRequestRecordsSnapshot,
  subscribeCodexRequestRecords,
} from "./codex-request-recorder";

function started(
  hostId: string,
  id: string,
  method: string,
  startedAtMs: number,
  params: unknown = {},
): Extract<CodexRequestLifecycleEvent, { type: "started" }> {
  return {
    type: "started",
    hostId,
    id,
    method,
    params,
    conversationId: null,
    priority: "interactive",
    source: "test",
    queueWaitMs: 3,
    startedAtMs,
    timeoutMs: 0,
  };
}

function completed(
  hostId: string,
  id: string,
  endedAtMs: number,
  result: unknown = { ok: true },
): CodexRequestLifecycleTerminalEvent {
  return {
    type: "completed",
    hostId,
    id,
    method: "thread/read",
    priority: "interactive",
    source: "test",
    timeoutMs: 0,
    durationMs: 40,
    queueWaitMs: 3,
    requestDurationMs: 37,
    queuedRequestCountAtEnqueue: 0,
    peakInFlightRequestCount: 1,
    peakBackgroundInFlightRequestCount: 0,
    coalescedRequestCount: 0,
    endedAtMs,
    result,
  };
}

function withCapture(hostIds: readonly string[], run: () => void): void {
  const changed = vi.fn();
  const unsubscribe = subscribeCodexRequestRecords(changed);
  try {
    run();
  } finally {
    unsubscribe();
    for (const hostId of hostIds) clearCodexRequestRecords(hostId);
  }
}

describe("Codex request recorder", () => {
  it("captures only while observed and preserves terminal mutation semantics after unsubscribe", () => {
    const hostId = "recorder-observed";
    const recorder = new CodexRequestRecorder(hostId);

    recorder.handle(started(hostId, "ignored", "thread/read", 50));
    expect(recorder.getEntries()).toEqual([]);

    const changed = vi.fn();
    const unsubscribe = subscribeCodexRequestRecords(changed);
    recorder.handle(started(hostId, "recorded", "thread/read", 100));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(
      getCodexRequestRecordsSnapshot().filter((entry) => entry.hostId === hostId),
    ).toHaveLength(1);

    unsubscribe();
    recorder.handle(completed(hostId, "recorded", 140, { secretResult: "not captured" }));

    const entry = recorder.getEntries()[0];
    expect(entry).toMatchObject({
      durationMs: 40,
      endedAtMs: 140,
      resultPreview: null,
      status: "completed",
    });
    expect(changed).toHaveBeenCalledTimes(1);
    clearCodexRequestRecords(hostId);
  });

  it("serializes the same bounded preview edge cases", () => {
    const preview = codexRequestPreview({
      bigint: 42n,
      error: new TypeError("boom"),
      fn: function namedFixture() {},
      json: {
        toJSON(key: string) {
          return `key:${key}`;
        },
      },
    });

    expect(preview).toContain('"bigint": "42"');
    expect(preview).toContain('"name": "TypeError"');
    expect(preview).toContain('"message": "boom"');
    expect(preview).toContain('"fn": "[Function namedFixture]"');
    expect(preview).toContain('"json": "key:json"');

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(codexRequestPreview(circular)).toContain(
      "[Unserializable payload: TypeError: Converting circular structure to JSON]",
    );

    const truncated = codexRequestPreview("x".repeat(20_000));
    expect(truncated).toHaveLength(12_000);
    expect(truncated.endsWith("\n… truncated preview")).toBe(true);
  });

  it("bounds entries and matching-request sequence keys with LRU eviction", () => {
    const hostId = "recorder-lru";
    const recorder = new CodexRequestRecorder(hostId);

    withCapture([hostId], () => {
      for (let index = 0; index <= 100; index += 1) {
        recorder.handle(started(hostId, `id-${index}`, `method-${index}`, index));
      }
      recorder.handle(started(hostId, "id-repeat", "method-0", 200));

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(100);
      expect(entries[0]).toMatchObject({
        method: "method-0",
        matchingRequestSequenceNumber: 1,
      });
    });
  });

  it("sorts the global snapshot by start time and clears one host independently", () => {
    const firstHost = "recorder-sort-a";
    const secondHost = "recorder-sort-b";
    const first = new CodexRequestRecorder(firstHost);
    const second = new CodexRequestRecorder(secondHost);

    withCapture([firstHost, secondHost], () => {
      first.handle(started(firstHost, "first", "thread/read", 100));
      second.handle(started(secondHost, "second", "thread/read", 200));

      expect(
        getCodexRequestRecordsSnapshot()
          .filter((entry) => entry.hostId === firstHost || entry.hostId === secondHost)
          .map((entry) => entry.hostId),
      ).toEqual([secondHost, firstHost]);

      clearCodexRequestRecords(firstHost);
      expect(
        getCodexRequestRecordsSnapshot()
          .filter((entry) => entry.hostId === firstHost || entry.hostId === secondHost)
          .map((entry) => entry.hostId),
      ).toEqual([secondHost]);
    });
  });
});
