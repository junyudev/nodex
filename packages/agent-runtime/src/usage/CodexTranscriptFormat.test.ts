import { assert, describe, it } from "@effect/vitest";

import { codexTranscriptFormat, parseCodexLine } from "./CodexTranscriptFormat.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 31, 12, 0, seconds)).toISOString();

const line = (type: string, payload: Record<string, unknown>, seconds = 0) =>
  JSON.stringify({ type, timestamp: at(seconds), payload });

const usage = (input: number, output: number, cached = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  total_tokens: input + output,
});

const tokenCount = (total: unknown, last: unknown, seconds = 0) =>
  line(
    "event_msg",
    { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
    seconds,
  );

function scan(lines: readonly string[]) {
  const state = codexTranscriptFormat.initialState();
  const records = lines.flatMap((text) => parseCodexLine(text, state));
  return { state, records };
}

const requests = (records: ReturnType<typeof scan>["records"]) =>
  records.flatMap((record) => (record.kind === "request" ? [record] : []));

describe("Codex transcript format", () => {
  it("attributes a request to the latest model and excludes cached input from uncached", () => {
    const { records } = scan([
      line("session_meta", { id: "session-1" }),
      line("turn_context", { model: "gpt-6.1-sol" }),
      tokenCount(usage(100, 10, 60), usage(100, 10, 60)),
    ]);
    assert.deepEqual(requests(records), [
      {
        kind: "request",
        timestampMs: Date.parse(at(0)),
        model: "gpt-6.1-sol",
        totals: {
          uncachedInputTokens: 40,
          cachedInputTokens: 60,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
        speed: "standard",
        dedupeKey: null,
      },
    ]);
  });

  it("does not bill a re-emitted cumulative snapshot twice", () => {
    const { records } = scan([
      line("turn_context", { model: "gpt-6.1-sol" }),
      tokenCount(usage(100, 10), usage(100, 10), 0),
      tokenCount(usage(100, 10), usage(100, 10), 1),
      tokenCount(usage(300, 30), usage(200, 20), 2),
    ]);
    assert.deepEqual(
      requests(records).map((record) => record.totals.uncachedInputTokens),
      [100, 200],
    );
  });

  it("skips context-size markers that carry no request", () => {
    const { records } = scan([
      line("turn_context", { model: "gpt-6.1-sol" }),
      tokenCount(usage(0, 0), usage(0, 0)),
    ]);
    assert.deepEqual(requests(records), []);
  });

  it("applies the service tier that was active when the request was read", () => {
    const { records } = scan([
      line("turn_context", { model: "gpt-6.1-sol" }),
      line("event_msg", {
        type: "thread_settings_applied",
        thread_settings: { service_tier: "priority" },
      }),
      tokenCount(usage(10, 1), usage(10, 1)),
    ]);
    assert.equal(requests(records)[0]?.speed, "fast");
  });

  it("does not bill history a fork copied from its parent", () => {
    const { records } = scan([
      line("session_meta", { id: "child", forked_from_id: "parent" }, 0),
      line("turn_context", { model: "gpt-6.1-sol" }, 0),
      tokenCount(usage(100, 10), usage(100, 10), 0),
      tokenCount(usage(150, 20), usage(50, 10), 0),
      tokenCount(usage(160, 21), usage(10, 1), 30),
    ]);
    assert.deepEqual(
      requests(records).map((record) => record.totals.uncachedInputTokens),
      [10],
    );
  });

  it("bills requests an interrupted turn never reported when records explain the gap", () => {
    const { records } = scan([
      line("turn_context", { model: "gpt-6.1-sol" }),
      tokenCount(usage(100, 10), usage(100, 10), 0),
      line("token_usage_record", { usage: usage(50, 5) }, 1),
      line("token_usage_record", { usage: usage(70, 7) }, 2),
      tokenCount(usage(220, 22), usage(70, 7), 3),
    ]);
    assert.deepEqual(
      requests(records).map((record) => record.totals.uncachedInputTokens),
      [100, 50, 70],
    );
  });

  it("counts a started task as a message, except inside a subagent or copied fork", () => {
    const started = (seconds: number) => line("event_msg", { type: "task_started" }, seconds);
    assert.deepEqual(
      scan([line("session_meta", { id: "a" }), started(1)]).records.map((r) => r.kind),
      ["message"],
    );
    assert.deepEqual(
      scan([line("session_meta", { id: "b", source: { subagent: "review" } }), started(1)]).records,
      [],
    );
    assert.deepEqual(
      scan([line("session_meta", { id: "c", forked_from_id: "a" }), started(0)]).records,
      [],
    );
  });

  it("follows the parent conversation and ignores metadata a fork copied from ancestors", () => {
    const { state } = scan([
      line("session_meta", {
        id: "child",
        source: { subagent: { thread_spawn: { parent_thread_id: "p" } } },
      }),
      line("session_meta", { id: "ancestor", forked_from_id: "older" }),
    ]);
    assert.deepEqual(codexTranscriptFormat.describeSession({ path: "/x.jsonl", state }), {
      sessionId: "p",
      subagent: true,
    });
  });

  it("recognizes its own saved state and rejects a foreign shape", () => {
    assert.equal(codexTranscriptFormat.isState(codexTranscriptFormat.initialState()), true);
    assert.equal(codexTranscriptFormat.isState({ model: "gpt" }), false);
  });
});
