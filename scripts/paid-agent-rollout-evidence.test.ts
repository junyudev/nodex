import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { readPaidAgentRolloutEvidence } from "./paid-agent-rollout-evidence";

const roots: string[] = [];

const makeHome = (): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ndx-paid-rollout-"));
  roots.push(home);
  fs.mkdirSync(path.join(home, "sessions", "2026", "09", "01"), { recursive: true });
  return home;
};

const writeRollout = (home: string, name: string, records: readonly unknown[]): void => {
  fs.writeFileSync(
    path.join(home, "sessions", "2026", "09", "01", `${name}.jsonl`),
    `${records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n")}\n`,
  );
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Paid Agent rollout evidence", () => {
  test("selects the exact thread and emits only bounded execution facts", async () => {
    const home = makeHome();
    writeRollout(home, "other", [
      { type: "session_meta", payload: { id: "other", model_provider: "openai" } },
    ]);
    writeRollout(home, "target", [
      { type: "session_meta", payload: { id: "thread-target", model_provider: "openai" } },
      {
        type: "turn_context",
        payload: { turn_id: "turn-1", model: "gpt-5.6-luna", effort: "max", prompt: "secret" },
      },
      {
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", status: "completed", input: "secret" },
      },
      "not-json",
    ]);

    expect(await readPaidAgentRolloutEvidence(home, "thread-target")).toEqual({
      threadId: "thread-target",
      modelProvider: "openai",
      turnContexts: [{ turnId: "turn-1", model: "gpt-5.6-luna", effort: "max" }],
      toolCalls: [
        { type: "custom_tool_call", name: "exec", server: null, tool: null, status: "completed" },
      ],
      malformedLineCount: 1,
    });
    expect(await readPaidAgentRolloutEvidence(home, "missing")).toBeNull();
  });
});
