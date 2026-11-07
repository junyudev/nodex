import { describe, expect, test } from "vite-plus/test";
import type {
  RecoveryDraftInspection,
  RecoveryPreviewResult,
} from "../../shared/block-documents/document-recovery";
import {
  loadRecoveryComparison,
  orderRecoveryEntries,
  recoveryDecision,
  recoveryEntryIsPending,
  recoveryNewContentMarkdown,
  type RecoveryComparison,
} from "./document-recovery-review";
import {
  formatRecoveryTime,
  receivedRecoveryKey,
  stagedRecoveryKey,
} from "./document-recovery-entries";
import { diffRecoveryDocuments } from "./document-recovery-diff";
import type { RecoveryStagingSummary } from "./document-recovery-staging";

const inspection = (overrides: Partial<RecoveryDraftInspection> = {}): RecoveryDraftInspection => ({
  summary: {
    draft_id: "draft",
    document_id: "document",
    source_title: "Research",
    revision: 1,
    created_at: "2026-11-07T00:15:00.000Z",
    received_at: "2026-11-07T00:15:00.000Z",
    payload_hash: "hash",
    byte_length: 200,
  },
  source_store_epoch: "epoch",
  source_generation: 1,
  current_generation: 1,
  current_head_seq: 1,
  already_saved: false,
  can_restore: false,
  can_copy: false,
  retained: true,
  restored: true,
  current: true,
  ...overrides,
});

const documentPreview = (markdown: string, title = "Research") => ({
  kind: "document" as const,
  title,
  rich_title: [],
  markdown,
  files: {},
});

const comparison = (
  before: string,
  after: string,
  merged = true,
  titles: readonly [string, string] = ["Research", "Research"],
): RecoveryComparison => ({
  kind: "diff",
  diff: diffRecoveryDocuments(
    { title: titles[0], markdown: before },
    { title: titles[1], markdown: after },
  )!,
  merged,
  before: documentPreview(before, titles[0]),
  after: documentPreview(after, titles[1]),
});

describe("recovery decisions", () => {
  test("a restorable draft leads with what restoring does to the Page", () => {
    expect(
      recoveryDecision(
        inspection({ can_restore: true, explanation: "ignored" }),
        comparison("Keep\n\nOld", "Keep\n\nFirst new\n\nSecond new"),
      ),
    ).toEqual({
      headline: "Restoring adds 2 blocks and removes 1.",
      detail: null,
      primary: "restore",
    });
    expect(
      recoveryDecision(
        inspection({ can_restore: true }),
        comparison("A long sentence that stays", "A long sentence that stays here"),
      ).headline,
    ).toBe("Restoring changes 1 block.");
  });

  test("a merge that changes nothing recommends discarding even when Core could restore it", () => {
    for (const capabilities of [{ can_restore: true }, { can_restore: false }])
      expect(
        recoveryDecision(inspection(capabilities), comparison("Same text", "Same text")),
      ).toEqual({
        headline: "Nothing new. Everything in these edits is already in the Page.",
        detail: null,
        primary: "discard",
      });
  });

  test("new content Core refuses to merge can still be carried over by hand", () => {
    const explanation = "They use files that weren’t captured with them.";
    expect(
      recoveryDecision(inspection({ explanation }), comparison("Keep", "Keep\n\nNew words")),
    ).toEqual({
      headline: "1 block isn’t in the Page yet.",
      detail: explanation,
      primary: "copy-new",
    });
  });

  test("edits that only remove content have nothing to carry over", () => {
    expect(recoveryDecision(inspection(), comparison("Keep\n\nRemoved later", "Keep"))).toEqual({
      headline: "These edits would remove 1 block, but can’t be applied.",
      detail: null,
      primary: "discard",
    });
  });

  test("a complete copy outranks copying text by hand", () => {
    expect(
      recoveryDecision(inspection({ can_copy: true }), comparison("Keep", "Keep\n\nNew")).primary,
    ).toBe("copy");
  });

  test("Blocks only in the Page are newer than captured edits, not lost content", () => {
    expect(
      recoveryDecision(
        inspection({ restored: false }),
        comparison("Older\n\nWritten after the edits", "Older", false),
      ).primary,
    ).toBe("discard");
    expect(
      recoveryDecision(
        inspection({ restored: false, can_copy: true }),
        comparison("Older\n\nWritten after the edits", "Older\n\nOnly in the edits", false),
      ).primary,
    ).toBe("copy");
  });

  test("a renamed Page counts as new content", () => {
    expect(
      recoveryDecision(
        inspection({ can_restore: true }),
        comparison("Same", "Same", true, ["Before", "After"]),
      ).headline,
    ).toBe("Restoring renames this Page.");
  });

  test("resolved drafts report what happened; only a discard can be undone", () => {
    const resolved = (resolution: NonNullable<RecoveryDraftInspection["summary"]["resolution"]>) =>
      recoveryDecision(
        inspection({ summary: { ...inspection().summary, resolution } }),
        comparison("Same", "Same"),
      ).primary;
    expect(resolved("discarded")).toBe("reopen");
    expect(resolved("restored")).toBeNull();
    expect(resolved("copied")).toBeNull();
    expect(resolved("already_saved")).toBeNull();
  });

  test("without a comparison only the whole version can be carried over", () => {
    const after = documentPreview("Only version");
    expect(
      recoveryDecision(inspection(), { kind: "document", after, hasCurrent: false }).primary,
    ).toBe("copy-all");
    expect(
      recoveryDecision(inspection({ can_copy: true }), {
        kind: "document",
        after,
        hasCurrent: false,
      }).primary,
    ).toBe("copy");
  });

  test("an unreadable preview falls back to the strongest action Core still allows", () => {
    const unavailable = { kind: "unavailable", explanation: "Too large" } as const;
    expect(recoveryDecision(inspection({ can_restore: true }), unavailable)).toMatchObject({
      primary: "restore",
      detail: "Too large",
    });
    expect(recoveryDecision(inspection({ can_copy: true }), unavailable).primary).toBe("copy");
    expect(recoveryDecision(inspection(), unavailable).primary).toBe("export");
  });

  test("no action is recommended before the comparison arrives", () => {
    expect(recoveryDecision(inspection({ can_restore: true }), { kind: "loading" }).primary).toBe(
      null,
    );
  });
});

describe("loading a comparison", () => {
  const complete = (markdown: string): RecoveryPreviewResult => ({
    kind: "complete",
    preview: documentPreview(markdown),
  });

  test("prefers the merged version even when Core will not apply it", async () => {
    const views: string[] = [];
    const result = await loadRecoveryComparison(inspection(), async (_, view) => {
      views.push(view);
      return complete(view);
    });
    expect(views.toSorted()).toEqual(["current", "restored"]);
    expect(result).toMatchObject({ kind: "diff", merged: true });
  });

  test("falls back to the captured edits when no merge exists", async () => {
    const views: string[] = [];
    const result = await loadRecoveryComparison(
      inspection({ restored: false }),
      async (_, view) => {
        views.push(view);
        return complete(view);
      },
    );
    expect(views.toSorted()).toEqual(["current", "retained"]);
    expect(result).toMatchObject({ kind: "diff", merged: false });
  });

  test("a missing original shows the edits themselves", async () => {
    const result = await loadRecoveryComparison(inspection({ current: false }), async () =>
      complete("Only version"),
    );
    expect(result).toMatchObject({ kind: "document", hasCurrent: false });
  });

  test("a failed read reports why instead of rejecting", async () => {
    await expect(
      loadRecoveryComparison(inspection(), async () => {
        throw new Error("Preview cannot be decoded");
      }),
    ).resolves.toEqual({ kind: "unavailable", explanation: "Preview cannot be decoded" });
  });
});

test("new content excludes change marks so pasting it cannot carry them back", () => {
  const diff = diffRecoveryDocuments(
    { title: "T", markdown: "Keep\n\nA sentence that gets a small edit" },
    { title: "T", markdown: "Keep\n\nA sentence that gets a tiny edit\n\nBrand new" },
  )!;
  expect(diff.edited).toBe(1);
  const markdown = recoveryNewContentMarkdown(diff);
  expect(markdown).toContain("A sentence that gets a tiny edit");
  expect(markdown).toContain("Brand new");
  expect(markdown).not.toContain("small");
  expect(markdown).not.toContain("Keep");
});

test("entries read newest first with pending ones separated from resolved", () => {
  const received = (id: string, createdAt: string, resolution?: "restored") => ({
    kind: "received" as const,
    key: receivedRecoveryKey(id),
    draft: {
      ...inspection().summary,
      draft_id: id,
      created_at: createdAt,
      ...(resolution ? { resolution, resolved_at: createdAt } : {}),
    },
  });
  const staged = {
    kind: "staged" as const,
    key: stagedRecoveryKey("local"),
    source: { sourceKey: "local", createdAt: "2026-11-06T00:00:00.000Z" } as RecoveryStagingSummary,
  };
  const { pending, resolved } = orderRecoveryEntries([
    received("old", "2026-11-01T00:00:00.000Z"),
    received("done", "2026-11-08T00:00:00.000Z", "restored"),
    staged,
    received("new", "2026-11-07T00:00:00.000Z"),
  ]);
  expect(pending.map((entry) => entry.key)).toEqual([
    receivedRecoveryKey("new"),
    stagedRecoveryKey("local"),
    receivedRecoveryKey("old"),
  ]);
  expect(resolved.map((entry) => entry.key)).toEqual([receivedRecoveryKey("done")]);
  expect(pending.every(recoveryEntryIsPending)).toBe(true);
});

test("a time reads without its year only within the current year", () => {
  const now = new Date("2026-11-07T12:00:00.000Z");
  expect(formatRecoveryTime("2026-03-02T12:00:00.000Z", now)).not.toContain("2026");
  expect(formatRecoveryTime("2025-03-02T12:00:00.000Z", now)).toContain("2025");
  expect(formatRecoveryTime("not a date", now)).toBe("not a date");
});
