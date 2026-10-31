import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  boundConversationRewindContext,
  conversationRewindContext,
  isExactConversationRewindTarget,
  resolveConversationRewindTargets,
  type ConversationRewindContext,
} from "./orchestrationV2Rewind.ts";

const run = (
  ordinal: number,
  status: ConversationRewindContext["runs"][number]["status"] = "completed",
  hasProviderTurn = true,
) => ({
  id: `run-${ordinal}`,
  ordinal,
  status,
  started: true,
  activeAttemptId: `attempt-${ordinal}`,
  hasProviderTurn,
});
const anchor = (ordinal: number, status = "missing") => ({
  id: `checkpoint-${ordinal}`,
  scopeId: "root",
  runId: ordinal === 0 ? null : `run-${ordinal}`,
  ordinalWithinScope: ordinal,
  appRunOrdinal: ordinal || null,
  status,
});
const context = (
  runs: ConversationRewindContext["runs"],
  checkpoints = [anchor(0), anchor(1), anchor(2)],
): ConversationRewindContext => ({
  runs,
  checkpoints,
  checkpointScopes: [{ id: "root", kind: "root_run" }],
});

describe("exact conversation rewind", () => {
  it("never skips a failed predecessor or an unrecorded pre-provider failure", () => {
    const input = context([
      run(1),
      run(2),
      run(3, "failed"),
      { ...run(4, "cancelled", false), started: false },
      run(5, "failed", false),
      run(6, "failed", false),
    ]);
    expect([...resolveConversationRewindTargets(input)]).toEqual([
      ["run-1", { scopeId: "root", checkpointId: "checkpoint-0", appRunOrdinal: 0 }],
      ["run-2", { scopeId: "root", checkpointId: "checkpoint-1", appRunOrdinal: 1 }],
      ["run-3", { scopeId: "root", checkpointId: "checkpoint-2", appRunOrdinal: 2 }],
    ]);
  });

  it("permits the first visible local Run at thread start, even with sparse ordinals", () => {
    const input = context([run(1, "rolled_back"), run(7)], []);
    expect(resolveConversationRewindTargets(input).get("run-7")).toEqual({
      scopeId: "root",
      checkpointId: null,
      appRunOrdinal: 0,
    });
  });

  it.each(["ready", "missing", "error", "stale"])(
    "accepts only conversation-restorable checkpoint status %s",
    (status) => {
      const targets = resolveConversationRewindTargets(
        context([run(1), run(2)], [anchor(1, status)]),
      );
      expect(targets.has("run-2")).toBe(status === "ready" || status === "missing");
    },
  );

  it("rejects an unusable recorded baseline instead of synthesizing a replacement", () => {
    expect(resolveConversationRewindTargets(context([run(1)], [anchor(0, "stale")])).size).toBe(0);
  });

  it("requires the predecessor's exact Run, ordinal, root scope, and provider turn", () => {
    for (const checkpoint of [
      { ...anchor(1), runId: null },
      { ...anchor(1), appRunOrdinal: 2 },
      { ...anchor(1), scopeId: "subagent" },
    ])
      expect(
        resolveConversationRewindTargets(context([run(1), run(2)], [checkpoint])).has("run-2"),
      ).toBe(false);
    expect(
      resolveConversationRewindTargets(context([run(1, "completed", false), run(2)])).has("run-2"),
    ).toBe(false);
  });

  it("walks surviving Runs after an earlier edit instead of subtracting one from the ordinal", () => {
    const targets = resolveConversationRewindTargets(
      context(
        [run(1), run(2, "rolled_back"), run(5), run(6)],
        [anchor(0), anchor(1), anchor(2), anchor(5)],
      ),
    );
    expect(targets.get("run-5")?.checkpointId).toBe("checkpoint-1");
    expect(targets.get("run-6")?.checkpointId).toBe("checkpoint-5");
  });

  it("preserves exact predecessors in bounded and disjoint windows", () => {
    const input = context([run(1), run(2), run(3, "failed"), run(5), run(6)]);
    const bounded = boundConversationRewindContext(input, new Set(["run-2", "run-6"]));
    expect(bounded.runs.map((entry) => entry.id)).toEqual(["run-1", "run-2", "run-5", "run-6"]);
    const targets = resolveConversationRewindTargets(bounded);
    expect(targets.get("run-2")?.checkpointId).toBe("checkpoint-1");
    expect(targets.has("run-5")).toBe(false);
    expect(targets.has("run-6")).toBe(false);
    expect(
      resolveConversationRewindTargets({
        ...bounded,
        runs: bounded.runs.filter((entry) => entry.id !== "run-1"),
      }).has("run-2"),
    ).toBe(false);
  });

  it("keeps inherited source Runs outside the local rewind scope", () => {
    const projection = {
      thread: { id: "local" },
      runs: [
        { ...run(1), threadId: "source", startedAt: null, activeAttemptId: null },
        { ...run(7), threadId: "local", startedAt: null, activeAttemptId: null },
      ],
      attempts: [],
      providerTurns: [],
      checkpointScopes: [
        { id: "source-root", kind: "root_run", threadId: "source" },
        { id: "root", kind: "root_run", threadId: "local" },
      ],
      checkpoints: [{ ...anchor(1), threadId: "source" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const local = conversationRewindContext(projection);
    expect(local.runs.map((entry) => entry.id)).toEqual(["run-7"]);
    expect(resolveConversationRewindTargets(local).get("run-7")?.appRunOrdinal).toBe(0);
  });

  it("rejects older forged targets including thread start", () => {
    const target = resolveConversationRewindTargets(context([run(1), run(2), run(3)])).get("run-3");
    expect(isExactConversationRewindTarget(target, anchor(2))).toBe(true);
    expect(isExactConversationRewindTarget(target, anchor(1))).toBe(false);
    expect(isExactConversationRewindTarget(target, anchor(0))).toBe(false);
  });
});
