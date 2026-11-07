import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { claudeTranscriptFormat } from "./ClaudeTranscriptFormat.ts";
import { codexTranscriptFormat } from "./CodexTranscriptFormat.ts";
import { listTranscriptFiles, readTranscript } from "./TranscriptReader.ts";

const assistant = (id: string, input = 10) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-31T16:20:58.000Z",
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, model: "claude-opus-5-5", usage: { input_tokens: input } },
  });

const inTemporaryDirectory = async <A>(use: (directory: string) => Promise<A>) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nodex-transcripts-"));
  try {
    return await use(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
};

describe("transcript reader", () => {
  it("finds plain and compressed transcripts in nested directories", () =>
    inTemporaryDirectory(async (directory) => {
      const nested = NodePath.join(directory, "2026", "10");
      await NodeFSP.mkdir(nested, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(nested, "a.jsonl"), "");
      await NodeFSP.writeFile(NodePath.join(nested, "b.jsonl.zst"), "");
      await NodeFSP.writeFile(NodePath.join(nested, "c.json"), "");
      const { files, failedPaths } = await listTranscriptFiles(directory);
      assert.deepEqual(files.map((file) => NodePath.basename(file.path)).sort(), [
        "a.jsonl",
        "b.jsonl.zst",
      ]);
      assert.equal(failedPaths, 0);
    }));

  it("treats a missing home as empty, not as a failure", async () => {
    const { files, failedPaths } = await listTranscriptFiles("/nonexistent/nodex/transcripts");
    assert.deepEqual(files, []);
    assert.equal(failedPaths, 0);
  });

  it("counts only finished lines and resumes where a growing file left off", () =>
    inTemporaryDirectory(async (directory) => {
      const path = NodePath.join(directory, "session.jsonl");
      await NodeFSP.writeFile(path, `${assistant("1")}\n${assistant("2").slice(0, 20)}`);
      const first = await readTranscript(path, claudeTranscriptFormat);
      assert.equal(first?.records.length, 1);
      assert.equal(first?.resumed, false);

      await NodeFSP.writeFile(path, `${assistant("1")}\n${assistant("2")}\n${assistant("3")}\n`);
      const second = await readTranscript(path, claudeTranscriptFormat, first!.position);
      assert.equal(second?.resumed, true);
      assert.deepEqual(
        second?.records.map((record) => (record.kind === "request" ? record.dedupeKey : null)),
        ["msg_2:req_2", "msg_3:req_3"],
      );
    }));

  it("re-reads from the start when a file no longer matches its saved position", () =>
    inTemporaryDirectory(async (directory) => {
      const path = NodePath.join(directory, "session.jsonl");
      await NodeFSP.writeFile(path, `${assistant("1")}\n`);
      const first = await readTranscript(path, claudeTranscriptFormat);
      await NodeFSP.writeFile(path, `${assistant("9")}\n${assistant("8")}\n`);
      const second = await readTranscript(path, claudeTranscriptFormat, first!.position);
      assert.equal(second?.resumed, false);
      assert.equal(second?.records.length, 2);
    }));

  it("reads a compressed snapshot whole, including a last line with no newline", () =>
    inTemporaryDirectory(async (directory) => {
      const path = NodePath.join(directory, "session.jsonl.zst");
      await NodeFSP.writeFile(
        path,
        NodeZlib.zstdCompressSync(Buffer.from(`${assistant("1")}\n${assistant("2")}`)),
      );
      const result = await readTranscript(path, claudeTranscriptFormat);
      assert.equal(result?.records.length, 2);
      assert.equal(result?.position.resumeOffset, 0);
    }));

  it("reports a corrupt compressed file as a failed read rather than an empty one", () =>
    inTemporaryDirectory(async (directory) => {
      const path = NodePath.join(directory, "session.jsonl.zst");
      await NodeFSP.writeFile(path, "not a zstd frame");
      assert.equal(await readTranscript(path, claudeTranscriptFormat), null);
    }));

  it("carries parser state across a resume so appended usage keeps its model", () =>
    inTemporaryDirectory(async (directory) => {
      const path = NodePath.join(directory, "rollout.jsonl");
      const meta = JSON.stringify({
        type: "session_meta",
        timestamp: "2026-10-31T12:00:00.000Z",
        payload: { id: "session-1" },
      });
      const context = JSON.stringify({
        type: "turn_context",
        timestamp: "2026-10-31T12:00:00.000Z",
        payload: { model: "gpt-6.1-sol" },
      });
      const usage = {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 1,
        total_tokens: 11,
      };
      const count = JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-31T12:00:05.000Z",
        payload: {
          type: "token_count",
          info: { total_token_usage: usage, last_token_usage: usage },
        },
      });
      await NodeFSP.writeFile(path, `${meta}\n${context}\n`);
      const first = await readTranscript(path, codexTranscriptFormat);
      assert.deepEqual(first?.records, []);
      assert.equal(first?.session.sessionId, "session-1");

      await NodeFSP.appendFile(path, `${count}\n`);
      const second = await readTranscript(path, codexTranscriptFormat, first!.position);
      assert.equal(second?.resumed, true);
      const record = second?.records[0];
      assert.equal(record?.kind === "request" ? record.model : null, "gpt-6.1-sol");
    }));

  it("skips lines that cannot matter without parsing them", () =>
    inTemporaryDirectory(async (directory) => {
      const path = NodePath.join(directory, "session.jsonl");
      await NodeFSP.writeFile(path, `not json at all\n${assistant("1")}\n`);
      const result = await readTranscript(path, claudeTranscriptFormat);
      assert.equal(result?.records.length, 1);
    }));
});
