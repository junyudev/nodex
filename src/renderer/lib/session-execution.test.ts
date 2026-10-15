import { describe, expect, test } from "vite-plus/test";
import {
  hasSessionConversation,
  resolveSessionExecution,
  resolveSessionExecutionLocation,
  resolveSessionMarkdownExport,
  resolveSessionPageSendTarget,
  resolveSessionProjectMove,
  runtimeSessionLiveIndicator,
  runtimeSessionTarget,
  sessionExecutionThreadId,
  type SessionExecutionSource,
} from "./session-execution";
import type { CodexThreadSummary } from "../../shared/types";

const base: SessionExecutionSource = {
  id: "session-1",
  projectId: "project-1",
  displayTitle: "Plan the launch",
  archived: false,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T01:00:00.000Z",
  thread: null,
  executionRef: null,
};
const runtime: SessionExecutionSource = {
  ...base,
  executionRef: { runtimeId: "runtime-1", threadId: "root-1" },
};
const nativeCodex: SessionExecutionSource = {
  ...base,
  thread: {
    threadId: "codex-1",
    executionHostId: "ssh-host",
    backendBinding: { kind: "codex" },
    parentThreadId: null,
    cwd: " /remote/repo ",
    managedWorktreePath: null,
  },
};
const nativeClaude: SessionExecutionSource = {
  ...base,
  thread: {
    threadId: "claude-1",
    executionHostId: "local",
    backendBinding: { kind: "claude", instanceConfigId: "claude-main" },
    cwd: "/repo",
  },
};

describe("Session execution projection", () => {
  test("classifies Runtime, native and unstarted Sessions by their execution owner", () => {
    expect(resolveSessionExecution(runtime)).toEqual({
      kind: "runtime",
      sessionId: "session-1",
      runtimeId: "runtime-1",
      rootThreadId: "root-1",
    });
    expect(resolveSessionExecution(nativeCodex)).toMatchObject({
      kind: "native",
      rootThreadId: "codex-1",
      hostId: "ssh-host",
      location: { cwd: "/remote/repo", managedWorktreePath: null },
    });
    expect(resolveSessionExecution(base)).toEqual({ kind: "unstarted", sessionId: "session-1" });
    expect([runtime, nativeClaude, base].map(sessionExecutionThreadId)).toEqual([
      "root-1",
      "claude-1",
      null,
    ]);
    expect([runtime, nativeClaude, base, null].map(hasSessionConversation)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(runtimeSessionTarget(runtime)).toEqual({
      sessionId: "session-1",
      rootThreadId: "root-1",
    });
    expect(runtimeSessionTarget(nativeCodex)).toBeNull();
  });

  test("reads Runtime location only from its execution owner", () => {
    const execution = resolveSessionExecution(runtime);
    expect(resolveSessionExecutionLocation(execution, null)).toBeNull();
    expect(
      resolveSessionExecutionLocation(execution, {
        hostId: "local",
        cwd: "/managed/feature/app",
        managedWorktreePath: "/managed/feature",
      }),
    ).toEqual({ cwd: "/managed/feature/app", managedWorktreePath: "/managed/feature" });
    expect(
      resolveSessionExecutionLocation(resolveSessionExecution(nativeClaude), {
        hostId: "local",
        cwd: "/elsewhere",
        managedWorktreePath: null,
      }),
    ).toEqual({ cwd: "/repo", managedWorktreePath: null });
  });

  test("routes export and Project moves to the owner that can perform them", () => {
    expect(resolveSessionMarkdownExport(resolveSessionExecution(runtime))).toEqual({
      kind: "runtime",
      target: { sessionId: "session-1", threadId: "root-1" },
    });
    expect(resolveSessionMarkdownExport(resolveSessionExecution(nativeCodex))).toEqual({
      kind: "native",
      conversationId: "codex-1",
      executionHostId: "ssh-host",
      parentConversationId: null,
    });
    expect(resolveSessionMarkdownExport(resolveSessionExecution(nativeClaude))).toBeNull();
    expect(resolveSessionMarkdownExport(resolveSessionExecution(base))).toBeNull();

    expect(resolveSessionProjectMove(resolveSessionExecution(runtime))).toEqual({
      kind: "runtime",
      sessionId: "session-1",
    });
    expect(resolveSessionProjectMove(resolveSessionExecution(nativeCodex))).toEqual({
      kind: "codex-thread",
      threadId: "codex-1",
    });
    expect(resolveSessionProjectMove(resolveSessionExecution(nativeClaude))).toBeNull();
    expect(resolveSessionProjectMove(resolveSessionExecution(base))).toBeNull();
  });

  test("never offers a bound Runtime Session as a new launch target", () => {
    const target = resolveSessionPageSendTarget(runtime, "project-1", null);
    expect(target.kind).toBe("thread");
    expect(target.kind === "thread" ? target.thread : null).toMatchObject({
      threadId: "root-1",
      threadName: "Plan the launch",
      archived: false,
    });
    expect(resolveSessionPageSendTarget(base, "project-1", null)).toEqual({ kind: "launch" });
    expect(resolveSessionPageSendTarget(base, "project-2", null)).toEqual({ kind: "none" });
    const nativeThread = { threadId: "codex-1" } as CodexThreadSummary;
    expect(resolveSessionPageSendTarget(nativeCodex, "project-1", nativeThread)).toEqual({
      kind: "thread",
      thread: nativeThread,
    });
  });

  test("treats absent activity as idle", () => {
    expect(runtimeSessionLiveIndicator(null)).toBeNull();
    expect(runtimeSessionLiveIndicator({ status: "background" })).toBe("background");
  });
});
