import { describe, expect, test } from "vitest";
import {
  isCodexSubagentUnresolvedStatus,
  projectCodexSubagentThreadStatus,
  selectCodexSubagentStatusEvidence,
  type CodexSubagentStatusEvidence,
} from "./codex-subagent-overview";

describe("Codex subagent overview domain", () => {
  test("keeps unloaded Threads unresolved and projects active waiting flags", () => {
    expect(projectCodexSubagentThreadStatus({ statusType: "notLoaded", activeFlags: [] })).toBe(
      "unknown",
    );
    expect(
      projectCodexSubagentThreadStatus({
        statusType: "active",
        activeFlags: ["waitingOnUserInput"],
      }),
    ).toBe("waiting");
    expect(projectCodexSubagentThreadStatus({ statusType: "active", activeFlags: [] })).toBe(
      "active",
    );
    expect(projectCodexSubagentThreadStatus({ statusType: "idle", activeFlags: [] })).toBe("done");
    expect(isCodexSubagentUnresolvedStatus("unknown")).toBe(true);
  });

  test("rejects weak and stale evidence while allowing a later notification to reopen work", () => {
    const completion: CodexSubagentStatusEvidence = {
      status: "done",
      kind: "completion",
      sourceRevision: 12,
      observedAtMs: 120,
    };
    const staleMetadata: CodexSubagentStatusEvidence = {
      status: "unknown",
      kind: "metadata",
      sourceRevision: 99,
      observedAtMs: 130,
    };
    const nextTurn: CodexSubagentStatusEvidence = {
      status: "active",
      kind: "notification",
      sourceRevision: 13,
      observedAtMs: 140,
    };

    expect(selectCodexSubagentStatusEvidence(completion, staleMetadata)).toEqual(completion);
    expect(selectCodexSubagentStatusEvidence(completion, nextTurn)).toEqual(nextTurn);
    expect(
      selectCodexSubagentStatusEvidence(completion, {
        ...nextTurn,
        sourceRevision: 1,
        observedAtMs: completion.observedAtMs + 1,
      }),
    ).toEqual(completion);
    expect(
      selectCodexSubagentStatusEvidence(
        { ...completion, sourceRevision: 199, observedAtMs: 1_785_000_001_000 },
        { ...nextTurn, sourceRevision: 200, observedAtMs: 1_784_000_000_000 },
      ),
    ).toEqual({ ...nextTurn, sourceRevision: 200, observedAtMs: 1_784_000_000_000 });
    const reconciled: CodexSubagentStatusEvidence = {
      status: "done",
      kind: "reconciliation",
      sourceRevision: 0,
      observedAtMs: 1,
    };
    expect(selectCodexSubagentStatusEvidence(nextTurn, reconciled)).toEqual(reconciled);
    expect(
      selectCodexSubagentStatusEvidence(reconciled, {
        ...nextTurn,
        sourceRevision: 14,
        observedAtMs: 0,
      }),
    ).toMatchObject({ status: "active", kind: "notification", sourceRevision: 14 });
  });
});
