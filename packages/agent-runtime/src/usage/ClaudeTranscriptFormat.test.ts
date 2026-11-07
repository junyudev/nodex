import { assert, describe, it } from "@effect/vitest";

import { claudeTranscriptFormat, parseClaudeLine } from "./ClaudeTranscriptFormat.ts";

const assistant = (overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-31T16:20:58.000Z",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
        output_tokens: 20,
        ...usage,
      },
    },
    ...overrides,
  });

const user = (overrides: Record<string, unknown> = {}, content: unknown = "fix the build") =>
  JSON.stringify({
    type: "user",
    timestamp: "2026-10-31T16:20:00.000Z",
    uuid: "user-1",
    message: { role: "user", content },
    ...overrides,
  });

describe("Claude transcript format", () => {
  it("reads a billed request with a key that collapses repeated content blocks", () => {
    assert.deepEqual(parseClaudeLine(assistant()), [
      {
        kind: "request",
        timestampMs: Date.parse("2026-10-31T16:20:58.000Z"),
        model: "claude-opus-5-5",
        totals: {
          uncachedInputTokens: 10,
          cachedInputTokens: 1000,
          cacheCreationTokens: 50,
          outputTokens: 20,
          reasoningTokens: 0,
        },
        speed: "standard",
        dedupeKey: "msg_1:req_1",
      },
    ]);
  });

  it("bills advisor iterations as their own model and keeps the fast tier", () => {
    const records = parseClaudeLine(
      assistant(
        {},
        {
          speed: "fast",
          iterations: [
            { type: "assistant_message", input_tokens: 999 },
            {
              type: "advisor_message",
              model: "claude-fable-5-1",
              input_tokens: 7,
              output_tokens: 3,
            },
          ],
        },
      ),
    );
    assert.equal(records.length, 2);
    const advisor = records[1];
    assert.equal(advisor?.kind, "request");
    if (advisor?.kind !== "request") return;
    assert.equal(advisor.model, "claude-fable-5-1");
    assert.equal(advisor.speed, "fast");
    assert.equal(advisor.totals.uncachedInputTokens, 7);
    assert.equal(advisor.dedupeKey, "msg_1:req_1:advisor:1");
  });

  it("ignores synthetic placeholders that never reached the API", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-31T16:20:58.000Z",
      message: { model: "<synthetic>", usage: { input_tokens: 5 } },
    });
    assert.deepEqual(parseClaudeLine(line), []);
  });

  it("counts what a person typed and nothing an agent or the tool loop wrote", () => {
    assert.deepEqual(parseClaudeLine(user()), [
      {
        kind: "message",
        timestampMs: Date.parse("2026-10-31T16:20:00.000Z"),
        dedupeKey: "user-1",
      },
    ]);
    assert.equal(parseClaudeLine(user({}, [{ type: "text", text: "and rebase" }])).length, 1);
    for (const line of [
      user({ isMeta: true }),
      user({ isSidechain: true }),
      user({ isCompactSummary: true }),
      user({}, [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
      user({}, "<local-command-stdout>done</local-command-stdout>"),
    ]) {
      assert.deepEqual(parseClaudeLine(line), []);
    }
  });

  it("tolerates a malformed line", () => {
    assert.deepEqual(parseClaudeLine('{"type":"assistant","usage":'), []);
  });

  it("names the session after its file and gives subagent work to its parent session", () => {
    assert.deepEqual(
      claudeTranscriptFormat.describeSession({
        path: "/home/.claude/projects/-repo/abc-123.jsonl",
        state: null,
      }),
      { sessionId: "abc-123", subagent: false },
    );
    assert.deepEqual(
      claudeTranscriptFormat.describeSession({
        path: "/home/.claude/projects/-repo/abc-123/subagents/agent-1.jsonl.zst",
        state: null,
      }),
      { sessionId: "abc-123", subagent: true },
    );
  });
});
