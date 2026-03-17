import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexThreadSummary } from "../../shared/types";
import {
  hasCodexSessionMaterialized,
  readCodexSessionThreadDetail,
  resetCodexSessionStoreCaches,
} from "./codex-session-store";

function makeLink(threadId: string): CodexThreadSummary {
  return {
    threadId,
    projectId: "codex",
    cardId: "card-1",
    threadName: null,
    threadPreview: "",
    modelProvider: "openai",
    cwd: null,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: new Date(0).toISOString(),
  };
}

function withTempCodexHome(run: (codexHome: string) => void): void {
  const previousCodexHome = process.env.CODEX_HOME;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-session-store-"));
  process.env.CODEX_HOME = tempDir;
  resetCodexSessionStoreCaches();

  try {
    run(tempDir);
  } finally {
    if (previousCodexHome) {
      process.env.CODEX_HOME = previousCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
    resetCodexSessionStoreCaches();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  resetCodexSessionStoreCaches();
});

describe("codex-session-store", () => {
  test("materializes modern jsonl sessions into thread detail", () => {
    withTempCodexHome((codexHome) => {
      fs.mkdirSync(path.join(codexHome, "sessions", "2026", "03", "17"), { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "session_index.jsonl"),
        JSON.stringify({
          id: "thr_session",
          thread_name: "Imported thread",
          updated_at: "2026-03-17T10:03:00.000Z",
        }) + "\n",
      );
      fs.writeFileSync(
        path.join(codexHome, "sessions", "2026", "03", "17", "rollout-2026-03-17T10-00-00-thr_session.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-03-17T10:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "thr_session",
              timestamp: "2026-03-17T10:00:00.000Z",
              cwd: "/tmp/project",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-17T10:00:01.000Z",
            type: "event_msg",
            payload: {
              type: "task_started",
              turn_id: "turn_1",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-17T10:00:02.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Implement it" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-17T10:00:03.000Z",
            type: "response_item",
            payload: {
              type: "function_call",
              call_id: "call_1",
              name: "exec_command",
              arguments: "{\"cmd\":\"ls\"}",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-17T10:00:04.000Z",
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "call_1",
              output: "{\"ok\":true}",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-17T10:00:05.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  total_tokens: 12,
                  input_tokens: 5,
                  cached_input_tokens: 1,
                  output_tokens: 6,
                  reasoning_output_tokens: 2,
                },
                last_token_usage: {
                  total_tokens: 12,
                  input_tokens: 5,
                  cached_input_tokens: 1,
                  output_tokens: 6,
                  reasoning_output_tokens: 2,
                },
                model_context_window: 200_000,
              },
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-17T10:00:06.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }],
            },
          }),
        ].join("\n"),
      );

      const detail = readCodexSessionThreadDetail({
        threadId: "thr_session",
        link: makeLink("thr_session"),
      });

      expect(hasCodexSessionMaterialized("thr_session")).toBeTrue();
      expect(detail?.threadName).toBe("Imported thread");
      expect(detail?.cwd).toBe("/tmp/project");
      expect(detail?.turns.length).toBe(1);
      expect(detail?.turns[0]?.turnId).toBe("turn_1");
      expect(detail?.turns[0]?.tokenUsage?.modelContextWindow).toBe(200_000);
      expect(detail?.items.length).toBe(3);
      expect(detail?.items[1]?.toolCall?.subtype).toBe("command");
      expect(detail?.items[1]?.toolCall?.result ? JSON.stringify(detail.items[1].toolCall?.result) : "").toBe(
        JSON.stringify({ ok: true }),
      );
      expect(detail?.threadPreview).toBe("Done.");
    });
  });

  test("materializes legacy json sessions into thread detail", () => {
    withTempCodexHome((codexHome) => {
      fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "session_index.jsonl"),
        JSON.stringify({
          id: "thr_legacy",
          thread_name: "Legacy imported thread",
          updated_at: "2025-10-27T01:55:12.523Z",
        }) + "\n",
      );
      fs.writeFileSync(
        path.join(codexHome, "sessions", "rollout-2025-10-27-thr_legacy.json"),
        JSON.stringify({
          session: {
            timestamp: "2025-10-27T01:55:12.523Z",
            id: "thr_legacy",
            instructions: "",
          },
          items: [
            {
              role: "user",
              type: "message",
              content: [{ type: "input_text", text: "Hello" }],
            },
            {
              role: "assistant",
              type: "message",
              content: [{ type: "output_text", text: "Hi there" }],
            },
          ],
        }),
      );

      const detail = readCodexSessionThreadDetail({
        threadId: "thr_legacy",
        link: makeLink("thr_legacy"),
      });

      expect(detail?.threadName).toBe("Legacy imported thread");
      expect(detail?.turns.length).toBe(1);
      expect(detail?.items.length).toBe(2);
      expect(detail?.items[0]?.markdownText).toBe("Hello");
      expect(detail?.items[1]?.markdownText).toBe("Hi there");
      expect(detail?.threadPreview).toBe("Hi there");
    });
  });
});
