import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_ENDED_STEER_REASON,
  CODEX_INTERRUPTED_STEER_REASON,
  type CodexQueuedFollowUp,
} from "../../../shared/codex-queued-follow-up-state";
import {
  beginCodexQueuedFollowUpEdit,
  completeCodexQueuedFollowUp,
  enqueueCodexQueuedFollowUp,
  failCodexQueuedFollowUp,
  recoverEndedCodexQueuedFollowUps,
  recoverInterruptedCodexQueuedFollowUps,
  reorderCodexQueuedFollowUps,
  replaceCodexQueuedFollowUp,
  restoreCodexQueuedFollowUpEdit,
  resumeInterruptedCodexQueuedFollowUps,
  type CodexQueuedFollowUpLedgerState,
} from "./CodexQueuedFollowUpState";

function row(id: string, prompt = id): CodexQueuedFollowUp {
  return {
    followUpId: id,
    clientUserMessageId: `client-${id}`,
    threadId: "thread-queue",
    prompt,
    promptInput: { text: prompt },
    createdAtMs: 1,
    collaborationMode: null,
    serviceTier: null,
    summary: null,
    pause: null,
  };
}

function ledger(...entries: CodexQueuedFollowUp[]): CodexQueuedFollowUpLedgerState {
  return { ledgerRevision: 0, entries };
}

describe("CodexQueuedFollowUpState", () => {
  test("keeps explicit array order and appends omitted rows after a reorder", () => {
    const state = ledger(row("a"), row("b"), row("c"));
    const next = reorderCodexQueuedFollowUps(state, ["c", "unknown", "c"]);

    expect(next.entries.map((entry) => entry.followUpId)).toEqual(["c", "a", "b"]);
    expect(next.ledgerRevision).toBe(1);
  });

  test("recovers interrupted steers once at the front and preserves existing failures", () => {
    const failed = failCodexQueuedFollowUp(ledger(row("failed")), "failed", "network failed");
    const withQueue = enqueueCodexQueuedFollowUp(failed, row("ready"));
    const recovered = [row("steer-1"), row("steer-2")];

    const next = recoverInterruptedCodexQueuedFollowUps(withQueue, recovered);
    expect(next.entries.map((entry) => entry.followUpId)).toEqual([
      "steer-1",
      "steer-2",
      "failed",
      "ready",
    ]);
    expect(next.entries[0]?.pause).toEqual({
      kind: "interrupted",
      reason: CODEX_INTERRUPTED_STEER_REASON,
    });
    expect(next.entries[2]?.pause).toEqual({ kind: "failed", reason: "network failed" });
    expect(next.entries[3]?.pause?.kind).toBe("interrupted");

    expect(recoverInterruptedCodexQueuedFollowUps(next, recovered)).toBe(next);
  });

  test("Resume clears only interruption pauses", () => {
    const interrupted = recoverInterruptedCodexQueuedFollowUps(
      failCodexQueuedFollowUp(ledger(row("failed"), row("ready")), "failed", "no route"),
      [row("steer")],
    );
    const resumed = resumeInterruptedCodexQueuedFollowUps(interrupted);

    expect(resumed.entries.find((entry) => entry.followUpId === "steer")?.pause).toBeNull();
    expect(resumed.entries.find((entry) => entry.followUpId === "ready")?.pause).toBeNull();
    expect(resumed.entries.find((entry) => entry.followUpId === "failed")?.pause).toEqual({
      kind: "failed",
      reason: "no route",
    });
  });

  test("non-interrupted recovery fails only the recovered steers", () => {
    const next = recoverEndedCodexQueuedFollowUps(ledger(row("ready")), [row("steer")]);

    expect(next.entries.map((entry) => entry.followUpId)).toEqual(["steer", "ready"]);
    expect(next.entries[0]?.pause).toEqual({
      kind: "failed",
      reason: CODEX_ENDED_STEER_REASON,
    });
    expect(next.entries[1]?.pause).toBeNull();
    expect(recoverEndedCodexQueuedFollowUps(next, [row("steer")])).toBe(next);
  });

  test("restores an edit relative to surviving neighbors after concurrent reorder", () => {
    const started = beginCodexQueuedFollowUpEdit(ledger(row("a"), row("b"), row("c")), "b");
    expect(started.token).not.toBeNull();
    const reordered = reorderCodexQueuedFollowUps(started.state, ["c", "a"]);
    const restored = restoreCodexQueuedFollowUpEdit(reordered, started.token!);

    expect(restored.entries.map((entry) => entry.followUpId)).toEqual(["b", "c", "a"]);
    expect(restoreCodexQueuedFollowUpEdit(restored, started.token!)).toBe(restored);
  });

  test("completes a selected non-head row without disturbing the head", () => {
    const next = completeCodexQueuedFollowUp(ledger(row("a"), row("b"), row("c")), "b");
    expect(next.entries.map((entry) => entry.followUpId)).toEqual(["a", "c"]);
  });

  test("replaces an edited row without changing its identity or position", () => {
    const state = ledger(row("a"), row("b"), row("c"));
    const replacement = { ...state.entries[1]!, prompt: "edited", promptInput: { text: "edited" } };
    const next = replaceCodexQueuedFollowUp(state, replacement);

    expect(next.entries.map((entry) => entry.followUpId)).toEqual(["a", "b", "c"]);
    expect(next.entries[1]?.prompt).toBe("edited");
  });

  test("accepts attachment-only captured input", () => {
    const attachmentOnly: CodexQueuedFollowUp = {
      ...row("attachment", ""),
      promptInput: {
        text: "",
        images: [{ source: "asset://sha256/image" }],
      },
    };
    const next = enqueueCodexQueuedFollowUp(ledger(), attachmentOnly);
    expect(next.entries).toEqual([attachmentOnly]);
  });
});
