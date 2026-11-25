import { expect, test, vi, describe, afterEach, beforeEach } from "vite-plus/test";
import type {
  BlockDocumentSurfaceRuntime,
  BlockDocumentSurfaceStatus,
} from "./block-document-surface-runtime";
import type { CanvasSceneProvider, CanvasSceneProviderStatus } from "./canvas-scene-provider";
import { observeDocumentContentIssues } from "./document-content-issues";
import { observeCanvasContentIssues } from "./canvas-content-issues";
import { contentEditIssues, contentRecoveryIssueId } from "./content-edit-issues";
import { createPageDocument, openPageDocument } from "../../shared/block-documents";
import * as Y from "yjs";
import {
  DocumentLocalCheckpointError,
  captureDocumentLocalCheckpoint,
  hasDocumentUpdateContent,
  restoreDocumentLocalCheckpoint,
  IndexedDbDocumentLocalCheckpointStore,
  type DocumentRecoverySnapshot,
  type DocumentLocalCheckpoint,
} from "./document-local-checkpoint";
import {
  readMarkdown,
  writeMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "../../shared/nodex-markdown";
import {
  diffRecoveryDocuments,
  mergeInlineEdits,
  recoveryDiffHasChanges,
} from "./document-recovery-diff";
import type {
  RecoveryDraftInspection,
  RecoveryPreviewResult,
  RecoveryCaptureReceipt,
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
import type { RecoveryStagingSummary, FrozenRecoveryRecord } from "./document-recovery-staging";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { decodeRecoverySource } from "../../shared/block-documents/recovery-bundle";

describe("document content issues", () => {
  const scope = {
    libraryId: "library",
    routingContext: { kind: "project" as const, projectId: "project" },
    storeEpoch: "epoch",
    documentId: "document",
    ownerBlockId: "page",
    generation: 1,
  };

  test("a retained Page reports only actionable saves and clears after acknowledgement", async () => {
    vi.useFakeTimers();
    const { document } = createPageDocument({
      documentId: scope.documentId,
      initialTitle: "Research notes",
    });
    let status = {
      phase: "ready",
      provider: {
        phase: "synced",
        pendingUpdateCount: 0,
        checkpoint: { phase: "ready", failureCount: 0 },
      },
    } as BlockDocumentSurfaceStatus;
    const listeners = new Set<() => void>();
    const connect = vi.fn();
    const runtime = {
      descriptor: scope,
      document,
      getStatus: () => status,
      connect,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as BlockDocumentSurfaceRuntime;
    const release = observeDocumentContentIssues(runtime);
    const publish = (provider: Partial<BlockDocumentSurfaceStatus["provider"]>) => {
      status = { ...status, provider: { ...status.provider, ...provider } };
      listeners.forEach((listener) => listener());
    };
    try {
      publish({ phase: "saving", pendingUpdateCount: 1 });
      await vi.advanceTimersByTimeAsync(7999);
      expect(contentEditIssues.getSnapshot()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const issue = contentEditIssues.getSnapshot()[0]!;
      expect(issue.scope.routingContext).toEqual(scope.routingContext);
      expect(issue.location).toEqual({
        target: { kind: "page", pageId: "page" },
        label: "Research notes",
      });
      const retry = issue.actions[0]!;
      if (retry.kind !== "run") throw new Error("Expected owner retry");
      await retry.run();
      expect(connect).toHaveBeenCalledOnce();
      publish({ phase: "synced", pendingUpdateCount: 0 });
      expect(contentEditIssues.getSnapshot()).toEqual([]);
    } finally {
      release();
      document.destroy();
      vi.useRealTimers();
    }
    expect(listeners.size).toBe(0);
  });

  test("a Canvas problem and its retained request use the same draft identity", async () => {
    let status: CanvasSceneProviderStatus = {
      phase: "ready",
      connected: true,
      headSeq: 1,
      pendingMutationCount: 0,
      writeFrozen: false,
    };
    const listeners = new Set<() => void>();
    const checkpointRecovery = vi.fn(async () => {});
    const provider = {
      getStatus: () => status,
      checkpointRecovery,
      subscribeStatus: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as CanvasSceneProvider;
    const release = observeCanvasContentIssues(provider, scope);
    try {
      expect(contentEditIssues.getSnapshot()).toEqual([]);
      status = {
        ...status,
        phase: "reset-required",
        pendingMutationCount: 1,
        inFlightMutationId: "mutation",
      };
      listeners.forEach((listener) => listener());
      const issue = contentEditIssues.getSnapshot()[0]!;
      expect(issue.id).toBe(
        contentRecoveryIssueId(
          { ...scope, routingContext: { kind: "library" } },
          "epoch",
          "canvas:document:mutation",
        ),
      );
      status = { ...status, pendingMutationCount: 0, inFlightMutationId: undefined };
      listeners.forEach((listener) => listener());
      expect(contentEditIssues.getSnapshot()[0]?.id).toBe(issue.id);
      const review = issue.actions[0]!;
      if (review.kind !== "review") throw new Error("Expected recovery review");
      expect(review.scope.routingContext).toEqual(scope.routingContext);
      await review.prepare?.();
      expect(checkpointRecovery).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    expect(contentEditIssues.getSnapshot()).toEqual([]);
    expect(listeners.size).toBe(0);
  });
});

describe("document local checkpoint", () => {
  const boundary = {
    documentId: "document:card-1",
    storeEpoch: "store-1",
    generation: 1,
    headSeq: 4,
  } as const;

  describe("document local checkpoints", () => {
    test("recovers only local causal state missing from the durable server", () => {
      const server = createPageDocument({
        documentId: boundary.documentId,
        initialTitle: "Base",
      }).document;
      const local = new Y.Doc({ guid: boundary.documentId });
      Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
      openPageDocument(local).title.insert(4, " local");
      const checkpoint = captureDocumentLocalCheckpoint(local, boundary);

      const restarted = new Y.Doc({ guid: boundary.documentId });
      Y.applyUpdate(restarted, Y.encodeStateAsUpdate(server));
      const missing = restoreDocumentLocalCheckpoint(
        restarted,
        Y.encodeStateVector(server),
        checkpoint,
        "local-checkpoint",
      );

      expect(hasDocumentUpdateContent(missing)).toBe(true);
      Y.applyUpdate(server, missing);
      expect(openPageDocument(server).title.toString()).toBe("Base local");
      expect(openPageDocument(restarted).title.toString()).toBe("Base local");
      server.destroy();
      local.destroy();
      restarted.destroy();
    });

    test("returns an empty causal diff when the server already committed the cache", () => {
      const server = createPageDocument({
        documentId: boundary.documentId,
        initialTitle: "Committed",
      }).document;
      const checkpoint = captureDocumentLocalCheckpoint(server, boundary);
      const restarted = new Y.Doc({ guid: boundary.documentId });
      Y.applyUpdate(restarted, Y.encodeStateAsUpdate(server));

      const missing = restoreDocumentLocalCheckpoint(
        restarted,
        Y.encodeStateVector(server),
        checkpoint,
        "local-checkpoint",
      );

      expect(hasDocumentUpdateContent(missing)).toBe(false);
      server.destroy();
      restarted.destroy();
    });

    test("does not replay an already committed delete set as a local edit", () => {
      const server = createPageDocument({
        documentId: boundary.documentId,
        initialTitle: "Committed",
      }).document;
      const title = openPageDocument(server).title;
      title.insert(title.length, " transient");
      title.delete("Committed".length, " transient".length);
      const checkpoint = captureDocumentLocalCheckpoint(server, boundary);
      const restarted = new Y.Doc({ guid: boundary.documentId });
      Y.applyUpdate(restarted, Y.encodeStateAsUpdate(server));

      const missing = restoreDocumentLocalCheckpoint(
        restarted,
        Y.encodeStateVector(server),
        checkpoint,
        "local-checkpoint",
      );

      expect(hasDocumentUpdateContent(missing)).toBe(false);
      expect(openPageDocument(restarted).title.toString()).toBe("Committed");
      server.destroy();
      restarted.destroy();
    });

    test("validates a corrupt checkpoint before mutating the mounted document", () => {
      const mounted = createPageDocument({
        documentId: boundary.documentId,
        initialTitle: "Safe",
      }).document;
      const before = Y.encodeStateAsUpdate(mounted);
      const corrupt = new Y.Doc({ guid: boundary.documentId });
      corrupt.getMap("hidden").set("payload", true);
      let rejected = false;
      try {
        restoreDocumentLocalCheckpoint(
          mounted,
          Y.encodeStateVector(mounted),
          {
            ...boundary,
            state: Y.encodeStateAsUpdate(corrupt),
            updatedAt: "2026-07-11T00:00:00.000Z",
          },
          "local-checkpoint",
        );
      } catch (error) {
        rejected = error instanceof DocumentLocalCheckpointError;
      }

      expect(rejected).toBe(true);
      const after = Y.encodeStateAsUpdate(mounted);
      expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
      mounted.destroy();
      corrupt.destroy();
    });
  });
});

describe("document recovery diff", () => {
  const version = (markdown: string, title = "Title") => ({ title, markdown });
  const text = (value: string, styles?: MarkdownInline["styles"]): MarkdownInline => ({
    type: "text",
    text: value,
    ...(styles ? { styles } : {}),
  });
  const blockText = (block: MarkdownBlock): string =>
    (block.content as readonly MarkdownInline[]).map((inline) => inline.text ?? "").join("");
  const shape = (markdown: { before: string; after: string }) =>
    diffRecoveryDocuments(version(markdown.before), version(markdown.after))!.rows.map((row) => [
      row.kind,
      row.blocks.map(blockText),
    ]);

  test("identical documents have nothing to show", () => {
    const diff = diffRecoveryDocuments(version("One\n\nTwo"), version("One\n\nTwo"))!;
    expect(diff.rows).toEqual([]);
    expect(recoveryDiffHasChanges(diff)).toBe(false);
  });

  test("a blank paragraph is spacing, not a change", () => {
    const blank = { type: "paragraph", content: [] };
    const withBlank = writeMarkdown([
      ...readMarkdown("One\n\nTwo").slice(0, 1),
      blank,
      ...readMarkdown("Two"),
    ]);
    const diff = diffRecoveryDocuments(version("One\n\nTwo"), version(withBlank))!;
    expect(readMarkdown(withBlank).length).toBeGreaterThan(2);
    expect(recoveryDiffHasChanges(diff)).toBe(false);
  });

  test("a title change alone still counts as a change", () => {
    const diff = diffRecoveryDocuments(version("One", "Before"), version("One", "After"))!;
    expect(diff.title).toEqual({ before: "Before", after: "After" });
    expect(diff.rows).toEqual([]);
    expect(recoveryDiffHasChanges(diff)).toBe(true);
  });

  test("unchanged Blocks collapse beyond one line of context around each change", () => {
    const unchanged = ["A", "B", "C", "D", "E", "F"];
    const before = unchanged.join("\n\n");
    const after = [...unchanged, "G", ...unchanged.map((value) => `${value}2`)].join("\n\n");
    const prefixAndAddition = shape({
      before: `${before}\n\nA2\n\nB2\n\nC2\n\nD2\n\nE2\n\nF2`,
      after,
    });
    expect(prefixAndAddition).toEqual([
      ["unchanged", ["A", "B", "C", "D", "E"]],
      ["context", ["F"]],
      ["added", ["G"]],
      ["context", ["A2"]],
      ["unchanged", ["B2", "C2", "D2", "E2", "F2"]],
    ]);
  });

  test("a run too short to be worth collapsing stays visible", () => {
    expect(shape({ before: "A\n\nB\n\nC", after: "New\n\nA\n\nB\n\nC\n\nLast" })).toEqual([
      ["added", ["New"]],
      ["context", ["A", "B", "C"]],
      ["added", ["Last"]],
    ]);
  });

  test("a Block edited in place carries its word changes as marks, including in Chinese", () => {
    const diff = diffRecoveryDocuments(
      version("该有圆角的时候还是得有圆角，比如那个按钮。"),
      version("该有圆角的时候还是得有圆角，比如那个 inline code。"),
    )!;
    expect([diff.added, diff.removed, diff.edited]).toEqual([0, 0, 1]);
    const content = diff.rows[0]!.blocks[0]!.content as readonly MarkdownInline[];
    expect(content.map((inline) => inline.text ?? "").join("")).toContain("该有圆角");
    expect(
      content
        .filter((inline) => inline.styles?.backgroundColor === "red")
        .map((inline) => inline.text),
    ).toEqual(["按钮"]);
    expect(
      content
        .filter((inline) => inline.styles?.backgroundColor === "green")
        .map((inline) => inline.text)
        .join(""),
    ).toBe(" inline code");
  });

  test("unrelated replacements stay separate instead of producing unreadable marks", () => {
    const diff = diffRecoveryDocuments(
      version("The quick brown fox jumps over"),
      version("Completely different words appear here"),
    )!;
    expect([diff.added, diff.removed, diff.edited]).toEqual([1, 1, 0]);
  });

  test("a Block whose kind changed is a replacement, not an inline edit", () => {
    const diff = diffRecoveryDocuments(version("Same words here"), version("# Same words here"))!;
    expect([diff.added, diff.removed, diff.edited]).toEqual([1, 1, 0]);
  });

  test("appending to a very long paragraph stays an inline edit", () => {
    const long = "Retained offline content. ".repeat(3000).trim();
    const merged = mergeInlineEdits([text(long)], [text(`${long} Added.`)])!;
    expect(merged.at(-1)).toEqual(text(" Added.", { backgroundColor: "green" }));
    expect(merged.at(0)?.text).toBe(long);
  });

  test("styled runs and inline objects survive the merge", () => {
    const mention: MarkdownInline = { type: "pageMention", props: { pageId: "page" } };
    const merged = mergeInlineEdits(
      [text("Keep ", { bold: true }), mention, text(" this old tail of words")],
      [text("Keep ", { bold: true }), mention, text(" this new tail of words")],
    )!;
    expect(merged[0]).toEqual(text("Keep ", { bold: true }));
    expect(merged[1]).toEqual(mention);
    expect(merged.filter((inline) => inline.styles?.strike).map((inline) => inline.text)).toEqual([
      "old",
    ]);
  });
});

describe("document recovery review", () => {
  const inspection = (
    overrides: Partial<RecoveryDraftInspection> = {},
  ): RecoveryDraftInspection => ({
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
      const resolved = (
        resolution: NonNullable<RecoveryDraftInspection["summary"]["resolution"]>,
      ) =>
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
      source: {
        sourceKey: "local",
        createdAt: "2026-11-06T00:00:00.000Z",
      } as RecoveryStagingSummary,
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
});

describe("document recovery staging", () => {
  const scope = { libraryId: "library:one", routingContext: { kind: "library" as const } };
  const snapshot = (title = "x".repeat(70_020)): DocumentRecoverySnapshot => {
    const document = new Y.Doc();
    document.getText("title").insert(0, title);
    const state = Y.encodeStateAsUpdate(document);
    document.destroy();
    return {
      documentId: "document:one",
      storeEpoch: "epoch:one",
      generation: 1,
      headSeq: 1,
      state,
      updatedAt: "2026-09-12T00:00:00.000Z",
      recoveryId: "draft:one",
      schema: { ownerType: "page", schemaKey: "nodex.page", schemaVersion: 1 },
      error: { code: "unknown", message: "uncertain", retryable: false, resetRequired: false },
      submissions: [
        {
          documentId: "document:one",
          storeEpoch: "epoch:one",
          generation: 1,
          clientSessionId: "original:session",
          updateId: "original:update",
          baseHeadSeq: 1,
          update: new Uint8Array([255]),
          touchedBlockIds: [],
        },
      ],
    };
  };
  const receipt = (frozen: FrozenRecoveryRecord): RecoveryCaptureReceipt => ({
    draft_id: frozen.bundle.draftId,
    source_revision: frozen.bundle.sourceRevision,
    submitted_payload_hash: frozen.bundle.payloadHash,
    stored_payload_hash: frozen.bundle.payloadHash,
    stored_encoding: "bundle_v1",
    stored_byte_length: frozen.bundle.bytes.length,
  });
  beforeEach(() => vi.stubGlobal("IDBKeyRange", IDBKeyRange));
  afterEach(() => vi.unstubAllGlobals());

  test("two windows freeze the same exact package and retry identity across reopen", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
    const second = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
    await first.quarantine(snapshot(), { maxStateBytes: 200_000 });
    const original = await first.nextRecovery("document:one");
    const [entry] = (await first.staging.listSummaries(scope, null, null)).entries;
    const [a, b] = await Promise.all([
      first.staging.freeze(entry, scope, "epoch:one"),
      second.staging.freeze(entry, scope, "epoch:one"),
    ]);
    expect(a.operationId).toBe(b.operationId);
    expect(a.bundle).toEqual(b.bundle);
    expect(a.bundle.bytes.length).toBeLessThan(75_000);
    expect(await decodeRecoverySource(a.bundle.bytes)).toEqual(original);
    const reopened = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
    expect(await reopened.staging.freeze(entry, scope, "epoch:one")).toEqual(a);
    expect((await reopened.readRecovery(snapshot())).at(0)?.submissions?.[0].updateId).toBe(
      "original:update",
    );
  });

  test("wrong receipt coordinates never clear staging; an old ACK cannot clear a newer capture", async () => {
    const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory(), scope);
    await store.quarantine(snapshot("first"), { maxStateBytes: 200_000 });
    const [entry] = (await store.staging.listSummaries(scope, null, null)).entries;
    const frozen = await store.staging.freeze(entry, scope, "epoch:one");
    for (const wrong of [
      { ...receipt(frozen), draft_id: "other" },
      { ...receipt(frozen), submitted_payload_hash: "b".repeat(64) },
      { ...receipt(frozen), source_revision: "other" },
      { ...receipt(frozen), stored_byte_length: 1 },
    ])
      await expect(store.staging.acknowledge(entry, frozen, wrong)).rejects.toThrow(
        "wasn’t confirmed",
      );
    expect(await store.staging.countSummaries(scope, null)).toBe(1);
    await store.quarantine(snapshot("newer"), { maxStateBytes: 200_000 });
    expect(await store.staging.countSummaries(scope, null)).toBe(2);
    expect(await store.staging.acknowledge(entry, frozen, receipt(frozen))).toBe(true);
    expect(await store.staging.countSummaries(scope, null)).toBe(1);
    const remaining = (await store.staging.listSummaries(scope, null, null)).entries[0];
    expect(remaining.sourceRevision).not.toBe(entry.sourceRevision);
    const next = await store.staging.freeze(remaining, scope, "epoch:one");
    expect(next.bundle.draftId).not.toBe(frozen.bundle.draftId);
  });

  test("legacy rows without a verified Library stay discoverable and exportable", async () => {
    const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory());
    await store.quarantine(snapshot("earlier world"), { maxStateBytes: 200_000 });
    const [entry] = (await store.staging.listSummaries(scope, null, null)).entries;
    expect(entry.scope).toBeNull();
    await expect(store.staging.freeze(entry, scope, "another-epoch")).rejects.toThrow(
      "can’t tell which Library",
    );
    const bytes = await store.staging.export(entry);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("NDRE");
    expect(await store.staging.countSummaries(scope, null)).toBe(1);
    expect(
      (
        await store.staging.listSummaries(
          { ...scope, routingContext: { kind: "project", projectId: "project:other" } },
          null,
          null,
        )
      ).entries,
    ).toHaveLength(0);
  });

  test("resolve operations have one durable winner and late acknowledgements preserve newer actions", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbDocumentLocalCheckpointStore(factory, scope).staging;
    const second = new IndexedDbDocumentLocalCheckpointStore(factory, scope).staging;
    const [a, b] = await Promise.all([
      first.prepareOperation("resolve:draft", { operationId: "first", choice: "copy" }),
      second.prepareOperation("resolve:draft", { operationId: "second", choice: "copy" }),
    ]);
    expect(a).toEqual(b);
    await first.acknowledgeOperation("resolve:draft", a);
    const next = await second.prepareOperation("resolve:draft", {
      operationId: "new",
      choice: "reopen",
    });
    await first.acknowledgeOperation("resolve:draft", a);
    expect(await second.readOperation("resolve:draft")).toEqual(next);
  });

  test("explicit local removal clears only the reviewed package and rejects stale revisions", async () => {
    const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory());
    await store.quarantine(snapshot("first"), { maxStateBytes: 200_000 });
    const [entry] = (await store.staging.listSummaries(scope, null, null)).entries;
    await store.quarantine(
      { ...snapshot("second"), recoveryId: "draft:two" },
      { maxStateBytes: 200_000 },
    );
    await expect(store.staging.remove({ ...entry, sourceRevision: "stale" })).rejects.toThrow(
      "Review it again",
    );
    expect(await store.staging.countSummaries(scope, null)).toBe(2);
    await store.staging.remove(entry);
    expect(await store.staging.countSummaries(scope, null)).toBe(1);
    await expect(store.staging.export(entry)).rejects.toThrow("changed");
    const [remaining] = (await store.staging.listSummaries(scope, null, null)).entries;
    expect(remaining.sourceKey).not.toBe(entry.sourceKey);
    expect((await store.staging.export(remaining)).length).toBeGreaterThan(0);
  });

  test("a newer capture cannot be removed by an earlier review", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbDocumentLocalCheckpointStore(factory);
    const second = new IndexedDbDocumentLocalCheckpointStore(factory);
    await first.quarantine(snapshot("reviewed"), { maxStateBytes: 200_000 });
    const [reviewed] = (await first.staging.listSummaries(scope, null, null)).entries;
    await second.quarantine(snapshot("new edits"), { maxStateBytes: 200_000 });
    await expect(first.staging.remove(reviewed)).rejects.toThrow("Review it again");
    const [current] = (await first.staging.listSummaries(scope, null, null)).entries;
    expect(current.sourceRevision).not.toBe(reviewed.sourceRevision);
    expect(await second.nextRecovery("document:one")).not.toBeNull();
  });

  test("a receipt claim survives its window and prevents removal until acknowledged", async () => {
    const factory = new IDBFactory();
    const sender = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
    await sender.quarantine(snapshot(), { maxStateBytes: 200_000 });
    const [entry] = (await sender.staging.listSummaries(scope, null, null)).entries;
    const frozen = await sender.staging.freeze(entry, scope, "epoch:one");
    expect(await sender.staging.claimTransfer(entry)).toBe(false);
    const reopened = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
    await expect(reopened.staging.remove(entry)).rejects.toThrow(
      "recovery copy hasn’t been confirmed",
    );
    expect(await reopened.staging.claimTransfer(entry)).toBe(true);
    await reopened.staging.acknowledge(entry, frozen, receipt(frozen));
    expect(await reopened.staging.countSummaries(scope, null)).toBe(0);
  });
});

describe("document recovery store", () => {
  const boundary = { documentId: "document-1", storeEpoch: "epoch-1", generation: 1 };
  const checkpoint = (
    text: string,
    coverage: Record<string, number> = {},
  ): DocumentLocalCheckpoint => {
    const document = new Y.Doc();
    document.getText("text").insert(0, text);
    const state = Y.encodeStateAsUpdate(document);
    document.destroy();
    return { ...boundary, headSeq: 2, state, coverage, updatedAt: new Date().toISOString() };
  };
  const recovery = (value: DocumentLocalCheckpoint): DocumentRecoverySnapshot => ({
    ...value,
    recoveryId: "recovery-1",
    schema: { ownerType: "page", schemaKey: "nodex.page", schemaVersion: 1 },
    error: {
      code: "recovery_required",
      message: "Structural conflict",
      retryable: false,
      resetRequired: false,
    },
  });

  test("quarantine atomically preserves other writers and exact submissions without deleting another generation", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbDocumentLocalCheckpointStore(factory);
    const second = new IndexedDbDocumentLocalCheckpointStore(factory);
    const a = checkpoint("A", { a: 2 });
    const b = checkpoint("B", { b: 3 });
    const newer = { ...checkpoint("new generation"), generation: 2 };
    await Promise.all([first.write(a), second.write(b), second.write(newer)]);
    const submitted = {
      ...boundary,
      clientSessionId: "old-session",
      updateId: "exact-update",
      baseHeadSeq: 2,
      update: b.state,
      touchedBlockIds: [],
    };
    await first.recordSubmission(submitted, 2);
    await expect(first.recordSubmission({ ...submitted, update: a.state }, 2)).rejects.toThrow(
      "identity",
    );
    await first.quarantine(recovery(a), { maxStateBytes: 10000 });
    expect(await first.read(boundary)).toBeNull();
    expect(await first.read({ ...boundary, generation: 2 })).toMatchObject({ state: newer.state });
    const [retained] = await second.readRecovery(boundary);
    expect(retained).toMatchObject({ coverage: { a: 2, b: 3 }, submissions: [submitted] });
    const document = new Y.Doc();
    Y.applyUpdate(document, retained!.state);
    expect(["AB", "BA"]).toContain(document.getText("text").toString());
    document.destroy();
    await second.write(b);
    expect(await first.read(boundary)).not.toBeNull();
  });

  test("malformed cached bytes remain exportable when they cannot be merged", async () => {
    const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory());
    const malformed = new Uint8Array([255]);
    await store.write({ ...checkpoint("draft"), state: malformed });
    await store.quarantine(recovery(checkpoint("canonical")), { maxStateBytes: 10000 });
    const [retained] = await store.readRecovery(boundary);
    expect(retained?.unintegratedUpdates).toEqual([malformed]);
    const document = new Y.Doc();
    Y.applyUpdate(document, retained!.state);
    expect(document.getText("text").toString()).toBe("canonical");
    document.destroy();
    expect(await store.read(boundary)).toBeNull();
  });

  test("failed quarantine leaves the active bytes and original request intact", async () => {
    const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory());
    const value = checkpoint("retained");
    await store.write(value);
    const request = {
      ...boundary,
      clientSessionId: "session",
      updateId: "request",
      baseHeadSeq: 2,
      update: value.state,
      touchedBlockIds: [],
    };
    await store.recordSubmission(request, 2);
    await expect(store.quarantine(recovery(value), { maxStateBytes: 1 })).rejects.toThrow(
      "local limit",
    );
    expect(await store.read(boundary)).toMatchObject({
      state: value.state,
      submissions: [request],
    });
    expect(await store.readRecovery(boundary)).toHaveLength(0);
    await store.acknowledgeSubmission({ ...request, updateId: "another" });
    expect((await store.read(boundary))?.submissions).toHaveLength(1);
    await store.acknowledgeSubmission(request);
    expect((await store.read(boundary))?.submissions).toHaveLength(0);
  });
});
