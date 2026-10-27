import { assert, test } from "vitest";
import { boundSessionWaitResult } from "./SessionAppTools";
import type { SessionWaitResult } from "./SessionWaiter";
import { toolResultBytes } from "./app-tool-result";

const waiting = (): SessionWaitResult => ({
  reason: "snapshot",
  errors: [],
  targets: Array.from({ length: 8 }, (_, index) => ({
    sessionId: `session:${index}`,
    title: "Session",
    backend: "codex",
    agent: null,
    status: "idle",
    activeFlags: [],
    disposition: "complete",
    selectedRunId: "run",
    runId: "run",
    cursor: `status:${index}`,
    changed: true,
    progress: {
      availability: "available",
      coverage: "complete",
      nextCursor: null,
      latestMessage: {
        id: `message:${index}`,
        sourceThreadId: "thread",
        runId: "run",
        type: "agentMessage",
        status: "completed",
        content: {
          format: "text",
          text: "😀".repeat(80),
          offset: 0,
          totalChars: 90_000,
          nextCursor: "continuation".repeat(300),
        },
      },
      latestTool: { id: "command", runId: "run", type: "commandExecution", status: "completed" },
    },
  })),
});

test("preserves every target within the shared wait budget and explicitly defers progress", () => {
  const input = waiting();
  assert.isAbove(toolResultBytes({ ...input }), 32 * 1024);
  const result = boundSessionWaitResult(input);
  assert.isAtMost(toolResultBytes({ ...result }), 32 * 1024);
  assert.deepEqual(
    result.targets.map(({ progress: _progress, ...target }) => target),
    input.targets.map(({ progress: _progress, ...target }) => target),
  );
  assert.isTrue(result.targets.some((target) => target.progress?.reason === "response_budget"));
  assert.isTrue(result.targets.some((target) => target.progress?.latestMessage !== null));
  assert.deepEqual(result.errors, []);
  assert.equal(input.targets[7]?.progress?.availability, "available");
});

test("keeps oversized metadata failures per target rather than losing the whole wait", () => {
  const input = waiting();
  const result = boundSessionWaitResult({
    ...input,
    targets: input.targets.map((target) => ({ ...target, title: "😀".repeat(5000) })),
  });
  assert.isAtMost(toolResultBytes({ ...result }), 32 * 1024);
  assert.equal(result.targets.length + result.errors.length, 8);
  assert.isTrue(result.errors.every((error) => error.reason === "source_limit"));
});

test("retains each child execution when one Session exceeds the shared wait budget", () => {
  const input = waiting();
  const targets = input.targets.map((target, index) => ({
    ...target,
    sessionId: "session:shared",
    execution: { threadId: `child:${index}` },
    title: "😀".repeat(5000),
  }));
  const result = boundSessionWaitResult({ ...input, targets });
  assert.isAtMost(toolResultBytes({ ...result }), 32 * 1024);
  assert.isAbove(result.errors.length, 0);
  assert.deepEqual(
    [...result.targets, ...result.errors]
      .map((target) => [target.sessionId, target.execution?.threadId])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    targets
      .map((target) => [target.sessionId, target.execution.threadId])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
  assert.isTrue(result.errors.every((error) => error.reason === "source_limit"));
});
