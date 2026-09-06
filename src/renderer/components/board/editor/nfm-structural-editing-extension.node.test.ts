import type { BlockNoteEditor } from "@blocknote/core";
import { Schema } from "@tiptap/pm/model";
import { NodeSelection, type Selection } from "@tiptap/pm/state";
import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";
import { availableHistoryReconciliation } from "./testing/nfm-history-reconciliation";
import { NfmHistoryLane } from "./nfm-editor-history";
import type { PublicBlockTransferIntent } from "../../../../shared/block-transfer-transport";
import { noOpLocalCommit } from "../../../../shared/testing/local-commit";

import type {
  LibraryModuleApplyResult,
  LibraryStructuralEditResult,
} from "../../../../shared/library-module";
import type {
  applyLibraryModule,
  awaitStructuralClipboard,
  beginStructuralClipboard,
  publishStructuralClipboard,
  settleStructuralClipboard,
} from "../../../lib/api";
import {
  NfmStructuralEditingController,
  NfmStructuralEditingSession,
} from "./nfm-structural-editing-extension";

const digest = "c".repeat(64);
const clipboard = {
  bundleId: "bundle:test",
  capability: digest,
  manifestHash: digest,
  storeEpoch: "epoch:test",
} as const;
const writeClaim = (suffix: number) =>
  `0199134e-cbb0-7000-8000-${suffix.toString().padStart(12, "0")}`;

const atomicSelectionSchema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer*" },
    blockContainer: {
      attrs: { id: {} },
      content: "blockContent",
      group: "bnBlock",
    },
    atomicBlock: { atom: true, group: "blockContent" },
    text: { group: "inline" },
  },
  marks: {},
});

const atomicContentSelection = (blockId: string): Selection => {
  const doc = atomicSelectionSchema.node("doc", null, [
    atomicSelectionSchema.node("blockGroup", null, [
      atomicSelectionSchema.node("blockContainer", { id: blockId }, [
        atomicSelectionSchema.node("atomicBlock"),
      ]),
    ]),
  ]);
  return NodeSelection.create(doc, 2);
};

const receipt = (structuralEdit: LibraryStructuralEditResult) =>
  ({
    ok: true,
    localCommit: {
      status: "no_op",
      observed: { store_epoch: "epoch:test", commit_head: 4 },
    },
    value: {
      operationId: "operation:test",
      profileId: "profile:test",
      storeEpoch: "epoch:test",
      libraryId: "library:test",
      operationKind: "apply_structural_edit",
      duplicate: false,
      didMutate: true,
      createdTarget: null,
      canvasMutation: null,
      structuralEdit,
      affectedParentKeys: [],
      affectedPageIds: structuralEdit.affectedPageIds,
      affectedDatabaseIds: structuralEdit.affectedDatabaseIds,
      affectedViewIds: [],
      committedRevisions: {},
      commitSeq: 4,
      committedAt: "2026-08-21T00:00:00.000Z",
    },
  }) satisfies LibraryModuleApplyResult;

const structuralEdit = (input: {
  readonly operationKind: string;
  readonly clipboard?: typeof clipboard | null;
  readonly resultRootBlockIds?: readonly string[];
  readonly resumeBlockId?: string;
}) => ({
  operationKind: input.operationKind,
  sourceRootBlockIds: ["text", "page"],
  resultRootBlockIds: input.resultRootBlockIds ?? [],
  copiedBlockIds: {},
  copiedDocumentIds: {},
  documentCommits: [],
  affectedPageIds: ["page"],
  affectedDatabaseIds: [],
  clipboard: input.clipboard ?? null,
  history:
    input.operationKind === "capture_clipboard"
      ? null
      : {
          recipeOperationId: `recipe:${input.operationKind}`,
          recipeHash: digest,
          storeEpoch: "epoch:test",
        },
  supersededHistoryRecipeOperationIds: [],
  resume: input.resumeBlockId
    ? {
        blockId: input.resumeBlockId,
        edge: "end" as const,
        fallbackBeforeBlockId: null,
        fallbackAfterBlockId: null,
      }
    : null,
});

const transfer = (
  session: NfmStructuralEditingSession,
  documentId = "document:test",
  preferredSelectionBlockId?: string,
) => {
  const head = { documentId, storeEpoch: "epoch:test", generation: 1, expectedHeadSeq: 1 };
  return session.transferBlocks({
    mode: "move",
    rootBlockIds: ["text", "page"],
    target: { parentBlockId: null, beforeBlockId: null },
    prepareHeads: async () => ({ sourceHead: head, targetHead: head }),
    preferredSelectionBlockId,
  });
};

describe("NFM structural editing session", () => {
  test("a ready Cut envelope awaits source settlement and keeps its original paste selection", async () => {
    const document = new Y.Doc();
    const undoManager = new Y.UndoManager(document.getArray("history"));
    const original = { id: "original-target", type: "page" };
    const later = { id: "later-target", type: "page" };
    let selected = original;
    let notifyWaiting!: () => void;
    let settle!: () => void;
    const waiting = new Promise<void>((resolve) => {
      notifyWaiting = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const awaited: Array<Parameters<typeof awaitStructuralClipboard>[0]> = [];
    const requests: Array<Parameters<typeof applyLibraryModule>[1]> = [];
    const envelope = {
      version: 1 as const,
      profileId: "profile:test",
      libraryId: "library:test",
      ...clipboard,
      actionHint: "cut" as const,
    };
    const editor = {
      getBlock: (id: string) => [original, later].find((block) => block.id === id),
      getParentBlock: () => undefined,
      getSelection: () => ({ blocks: [selected] }),
      prosemirrorView: { state: { selection: { nodes: [] } } },
      getExtension: () => ({
        undoManager,
        fragment: document.getXmlFragment("body"),
        bindHistory: () => () => undefined,
      }),
    } as unknown as BlockNoteEditor<any, any, any>;
    const session = new NfmStructuralEditingSession({
      editor,
      historyReconciliation: availableHistoryReconciliation,
      runtime: {
        accessContext: { kind: "library" },
        libraryId: "library:test",
        source: { documentId: "document:target", storeEpoch: "epoch:test", generation: 1 },
        participant: {
          prepareAndFence: async () => ({
            documentId: "document:target",
            storeEpoch: "epoch:test",
            generation: 1,
            expectedHeadSeq: 1,
          }),
        },
        getContainer: () => null,
      },
      awaitClipboard: async (input) => {
        awaited.push(input);
        notifyWaiting();
        await settled;
        return { kind: "ready", disposition: "structural", envelope };
      },
      apply: async (_access, request) => {
        requests.push(request);
        return receipt(structuralEdit({ operationKind: "replace_selection" }));
      },
    });
    try {
      expect(
        session.handleStructuralClaimPaste(
          {
            version: 1,
            phase: "ready",
            writeClaim: writeClaim(101),
            actionHint: "cut",
            envelope,
          },
          [],
        ),
      ).toBe(true);
      await Promise.race([waiting, session.whenIdle()]);
      expect(awaited).toEqual([{ writeClaim: writeClaim(101), publishedEnvelope: envelope }]);
      expect(requests).toEqual([]);
      selected = later;
      settle();
      await session.whenIdle();
      expect(requests).toHaveLength(1);
      expect(requests[0].operation).toMatchObject({
        kind: "apply_structural_edit",
        command: {
          kind: "replace_selection",
          selection: { rootBlockIds: [original.id] },
          replacement: { kind: "clipboard", bundle: clipboard },
        },
      });
    } finally {
      settle();
      await session.close();
      undoManager.destroy();
      document.destroy();
    }
  });

  test.each([
    { symmetric: true, close: false, receiving: false, mode: "move" as const },
    { symmetric: false, close: false, receiving: false, mode: "move" as const },
    { symmetric: true, close: true, receiving: false, mode: "move" as const },
    { symmetric: false, close: false, receiving: true, mode: "move" as const },
    { symmetric: false, close: true, receiving: true, mode: "move" as const },
    { symmetric: false, close: false, receiving: true, mode: "copy" as const },
  ])(
    "Page transfer retains its timeline through a lost response, receiving: $receiving, mode: $mode, symmetric: $symmetric, close: $close",
    async ({ symmetric, close, receiving, mode }) => {
      const document = new Y.Doc();
      const manager = new Y.UndoManager(document.getXmlFragment("body"));
      const history = new NfmHistoryLane({ undoManager: manager });
      const sent: PublicBlockTransferIntent[] = [];
      const reversed: string[] = [];
      const released: string[] = [];
      let preparations = 0;
      let fence: (() => void) | undefined;
      const pendingFence = new Promise<void>((resolve) => {
        fence = resolve;
      });
      const token = {
        transferOperationId: "promotion:one",
        recipeHash: digest,
        storeEpoch: "epoch:test",
      };
      const session = new NfmStructuralEditingSession({
        editor: {
          getBlock: () => ({ id: "page", type: "page" }),
          getExtension: () => ({
            undoManager: manager,
            fragment: document.getXmlFragment("body"),
            bindHistory: () => () => undefined,
          }),
        } as unknown as BlockNoteEditor<any, any, any>,
        historyLane: history,
        historyReconciliation: availableHistoryReconciliation,
        runtime: {
          accessContext: { kind: "project", projectId: "project:test" },
          libraryId: "library:test",
          source: { documentId: "document:test", storeEpoch: "epoch:test", generation: 1 },
          getContainer: () => null,
          participant: {
            prepareAndFence: async () => {
              if (preparations++ === 1) await pendingFence;
              return {
                documentId: "document:test",
                storeEpoch: "epoch:test",
                generation: 1,
                expectedHeadSeq: 1,
              };
            },
          },
        },
        apply: async (_access, request) => {
          if (
            request.operation.kind === "apply_structural_edit" &&
            request.operation.command.kind === "release_history"
          )
            released.push(
              ...request.operation.command.tokens.map((token) => token.recipeOperationId),
            );
          if (request.operation.kind === "reverse_structural_edit") {
            const operationId = request.operation.token.recipeOperationId;
            reversed.push(operationId);
            return receipt({
              ...structuralEdit({ operationKind: "reverse_structural_edit" }),
              history: {
                recipeOperationId: `inverse:${operationId}`,
                recipeHash: digest,
                storeEpoch: "epoch:test",
              },
            });
          }
          return receipt(structuralEdit({ operationKind: "delete" }));
        },
        preparePromotion: async (input) => ({
          operationId: "promotion:one",
          projectId: input.projectId,
          storeEpoch: input.storeEpoch,
          mode,
          rootBlockIds: input.rootBlockIds,
          source: { kind: "page", pageId: input.sourcePageId },
          causalDependencies: [
            {
              documentId: input.sourceHead.documentId,
              generation: input.sourceHead.generation,
              expectedHeadSeq: input.sourceHead.expectedHeadSeq,
            },
          ],
          target: {
            kind: "data_source",
            dataSourceId: "source:test",
            placement: {
              kind: "direct",
              viewId: "view:test",
              groupKey: "ship",
              preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
            },
          },
          promotionPolicy: "literal",
        }),
        transfer: async (_projectId, request) => {
          sent.push(request);
          if (sent.length === 1)
            return {
              ok: false,
              error: {
                code: "unknown",
                message: "Lost Promotion response",
                retryable: true,
                reloadRequired: false,
              },
            };
          return {
            ok: true,
            localCommit: noOpLocalCommit(request.storeEpoch),
            value: {
              operationId: request.operationId,
              projectId: request.projectId,
              storeEpoch: request.storeEpoch,
              mode: request.mode,
              duplicate: true,
              sourceRootBlockIds: request.rootBlockIds,
              resultRootBlockIds: request.rootBlockIds,
              copiedBlockIds: {},
              transformationEvidence: [],
              finalLocations: {},
              finalLocationRevisions: {},
              documentCommits: [],
              affectedDatabaseBlockIds: [],
              commitSeq: 2,
              committedAt: "2026-09-05T00:00:00Z",
              undoToken: token,
              history: symmetric
                ? {
                    recipeOperationId: token.transferOperationId,
                    recipeHash: token.recipeHash,
                    storeEpoch: token.storeEpoch,
                  }
                : null,
            },
          };
        },
      });
      try {
        session.deleteBlocks(["page"], "forward");
        await session.whenIdle();
        const pending = receiving
          ? session.receivePages({
              projectId: "project:test",
              storeEpoch: "epoch:test",
              mode,
              rootBlockIds: ["page"],
              dataSourceId: "source:test",
              target: { kind: "page", pageId: "page:host" },
            })
          : session.promoteBlocks({
              projectId: "project:test",
              storeEpoch: "epoch:test",
              sourcePageId: "page:host",
              sourceDocumentId: "document:test",
              sourceDocumentGeneration: 1,
              rootBlockIds: ["page"],
              destination: { kind: "db-column", projectId: "project:test", columnId: "ship" },
            });
        const rejected = expect(pending).rejects.toThrow("Lost Promotion response");
        expect(history.snapshot().undo).toMatchObject({
          status: "waiting",
          label: receiving
            ? mode === "move"
              ? "Move Pages here"
              : "Copy Pages here"
            : "Move to Database",
        });
        expect(sent).toEqual([]);
        history.requestUndo();
        fence!();
        await rejected;
        await session.whenIdle();
        expect(reversed).toEqual([]);
        if (receiving)
          expect(sent[0]).toMatchObject({
            mode,
            rootBlockIds: ["page"],
            source: { kind: "data_source", dataSourceId: "source:test" },
            target: { kind: "page", pageId: "page:host" },
            causalDependencies: [
              { documentId: "document:test", generation: 1, expectedHeadSeq: 1 },
            ],
          });
        if (close) {
          await history.close();
          expect(sent).toHaveLength(2);
          expect(sent[1]).toEqual(sent[0]);
          expect(released).toContain("promotion:one");
          expect(reversed).toEqual([]);
          return;
        }
        await session.recoverHistory();
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual(sent[0]);
        if (!symmetric) {
          await session.whenIdle();
          expect(reversed).toEqual([]);
          expect(history.snapshot().undo.status).toBe("blocked");
          expect(released).toContain("promotion:one");
          return;
        }
        // The queued Undo resumes only after confirmation, then fences its own inverse.
        expect(preparations).toBe(3);
        expect(reversed).toEqual(["promotion:one"]);
        expect(history.snapshot().redo.status).toBe("ready");
        history.requestRedo();
        await session.whenIdle();
        expect(reversed).toEqual(["promotion:one", "inverse:promotion:one"]);
      } finally {
        fence?.();
        await session.close();
        await history.close();
        manager.destroy();
        document.destroy();
      }
    },
  );

  test.each(["confirmed", "expired"] as const)(
    "an unconfirmed Cut preserves its claim through %s recovery",
    async (recovery) => {
      const document = new Y.Doc();
      const manager = new Y.UndoManager(document.getArray("history"));
      const block = { id: "page", type: "page" };
      const requests: Array<Parameters<typeof applyLibraryModule>[1]> = [];
      const settled: string[] = [];
      const reversed: string[] = [];
      const editor = {
        getBlock: () => block,
        getExtension: () => ({
          undoManager: manager,
          fragment: document.getXmlFragment("body"),
          bindHistory: () => () => undefined,
        }),
      } as unknown as BlockNoteEditor<any, any, any>;
      const session = new NfmStructuralEditingSession({
        editor,
        historyReconciliation: availableHistoryReconciliation,
        runtime: {
          accessContext: { kind: "library" },
          libraryId: "library:test",
          source: { documentId: "document:test", storeEpoch: "epoch:test", generation: 1 },
          participant: {
            prepareAndFence: async () => ({
              documentId: "document:test",
              storeEpoch: "epoch:test",
              generation: 1,
              expectedHeadSeq: 1,
            }),
          },
          getContainer: () => null,
        },
        beginClipboard: async () => ({ ok: true }),
        publishClipboard: async () => ({ ok: true }),
        settleClipboard: async (input) => {
          settled.push(input.outcome);
          return { ok: true };
        },
        apply: async (_access, request) => {
          const operation = request.operation;
          if (operation.kind === "reverse_structural_edit") {
            reversed.push(operation.token.recipeOperationId);
            return receipt(structuralEdit({ operationKind: "inverse" }));
          }
          if (operation.kind !== "apply_structural_edit") throw new Error("Unexpected command");
          if (operation.command.kind === "capture_clipboard")
            return receipt(structuralEdit({ operationKind: "capture_clipboard", clipboard }));
          if (
            operation.command.kind === "delete_selection" &&
            operation.command.reason.kind === "cut"
          ) {
            requests.push(request);
            if (requests.length === 1)
              return {
                ok: false,
                error: { code: "unknown", message: "Cut response lost", retryable: true },
              };
            if (recovery === "expired")
              return {
                ok: false,
                error: { code: "recovery_required", message: "Receipt expired", retryable: false },
              };
            return receipt(structuralEdit({ operationKind: "cut" }));
          }
          return receipt(structuralEdit({ operationKind: operation.command.kind }));
        },
      });
      try {
        expect(session.deleteBlocks(["page"], "backward")).toBe(true);
        await session.whenIdle();
        expect(
          session.handleClipboard(
            "cut",
            ["page"],
            { html: "<p>Page</p>", text: "Page" },
            writeClaim(100),
          ),
        ).toBe(true);
        await session.whenIdle();
        expect(settled).toEqual([]);
        session.handleKeyDown({ key: "z", metaKey: true } as KeyboardEvent);
        await session.whenIdle();
        expect(reversed).toEqual([]);
        await session.recoverHistory();
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        if (recovery === "expired") {
          expect(settled).toEqual([]);
          expect(session.historyControls.snapshot().undo).toMatchObject({
            status: "blocked",
            recoveryActions: ["reset"],
          });
          await session.recoverHistory();
          session.handleKeyDown({ key: "z", metaKey: true } as KeyboardEvent);
          await session.whenIdle();
          expect(requests).toHaveLength(2);
          expect(reversed).toEqual([]);
          return;
        }
        expect(settled).toEqual(["cut_committed"]);
        session.handleKeyDown({ key: "z", metaKey: true } as KeyboardEvent);
        await session.whenIdle();
        expect(reversed).toEqual(["recipe:cut"]);
      } finally {
        await session.close();
        manager.destroy();
        document.destroy();
      }
    },
  );

  test.each(["forward", "inverse"] as const)(
    "closing hands off a pending %s without waiting for Core or losing its late token",
    async (direction) => {
      const document = new Y.Doc();
      const manager = new Y.UndoManager(document.getArray("history"));
      let complete!: (result: LibraryStructuralEditResult) => void;
      const response = new Promise<LibraryStructuralEditResult>((resolve) => {
        complete = resolve;
      });
      let started!: () => void;
      const submitted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let acknowledged!: () => void;
      const cleaned = new Promise<void>((resolve) => {
        acknowledged = resolve;
      });
      const releases: string[] = [];
      const editor = {
        getExtension: () => ({
          undoManager: manager,
          fragment: document.getXmlFragment("body"),
          bindHistory: () => () => undefined,
        }),
      } as unknown as BlockNoteEditor<any, any, any>;
      const session = new NfmStructuralEditingSession({
        editor,
        historyReconciliation: availableHistoryReconciliation,
        runtime: {
          accessContext: { kind: "library" },
          libraryId: "library:test",
          source: { documentId: document.guid, storeEpoch: "epoch:test", generation: 1 },
          participant: {
            prepareAndFence: async () => ({
              documentId: document.guid,
              storeEpoch: "epoch:test",
              generation: 1,
              expectedHeadSeq: 1,
            }),
          },
          getContainer: () => null,
        },
        apply: async (_access, request) => {
          if (
            request.operation.kind === "apply_structural_edit" &&
            request.operation.command.kind === "move_selection"
          ) {
            if (direction === "inverse") return receipt(structuralEdit({ operationKind: "cut" }));
            started();
            return receipt(await response);
          }
          if (request.operation.kind === "reverse_structural_edit") {
            started();
            return receipt(await response);
          }
          if (
            request.operation.kind !== "apply_structural_edit" ||
            request.operation.command.kind !== "release_history"
          )
            throw new Error("Unexpected operation");
          const tokens = request.operation.command.tokens.map((token) => token.recipeOperationId);
          releases.push(...tokens);
          if (tokens.includes("recipe:late")) acknowledged();
          return receipt({ ...structuralEdit({ operationKind: "release" }), history: null });
        },
      });
      let forward: Promise<void> | undefined;
      try {
        if (direction === "inverse") {
          await transfer(session, document.guid);
          session.handleKeyDown({ key: "z", metaKey: true } as KeyboardEvent);
        } else {
          forward = transfer(session, document.guid).catch(() => undefined);
        }
        await submitted;
        await session.close();
        await forward;
        manager.destroy();
        document.destroy();
        expect(releases).toEqual([]);
        complete(structuralEdit({ operationKind: "late" }));
        await cleaned;
        expect(releases.at(-1)).toBe("recipe:late");
        expect(session.handleKeyDown({ key: "z", metaKey: true } as KeyboardEvent)).toBe(false);
      } finally {
        complete(structuralEdit({ operationKind: "late" }));
        await session.close();
        manager.destroy();
        document.destroy();
      }
    },
  );

  test.each(["thrown", "error_value", "rejected"] as const)(
    "recovers a %s inverse outcome with the correct request identity and head fence",
    async (failureMode) => {
      const document = new Y.Doc();
      const undoManager = new Y.UndoManager(document.getArray("history"));
      const requests: Array<Parameters<typeof applyLibraryModule>[1]> = [];
      const released: string[] = [];
      const errors: string[] = [];
      const editor = {
        getExtension: () => ({
          undoManager,
          fragment: document.getXmlFragment("body"),
          bindHistory: () => () => undefined,
          getSemanticSelection: () => undefined,
          restoreSemanticSelection: () => false,
        }),
      } as unknown as BlockNoteEditor<any, any, any>;
      const session = new NfmStructuralEditingSession({
        historyReconciliation: availableHistoryReconciliation,
        editor,
        runtime: {
          accessContext: { kind: "library" },
          libraryId: "library:test",
          source: { documentId: document.guid, storeEpoch: "epoch:test", generation: 1 },
          participant: {
            prepareAndFence: async () => {
              if (requests.length > 0 && failureMode !== "rejected")
                throw new Error("A committed inverse must not need a new head");
              return {
                documentId: document.guid,
                storeEpoch: "epoch:test",
                generation: 1,
                expectedHeadSeq: 1,
              };
            },
          },
          getContainer: () => null,
          onError: (error) => {
            errors.push(error);
          },
        },
        apply: async (_context, request) => {
          if (
            request.operation.kind === "apply_structural_edit" &&
            request.operation.command.kind === "move_selection"
          )
            return receipt(structuralEdit({ operationKind: "cut" }));
          if (request.operation.kind === "reverse_structural_edit") {
            requests.push(request);
            if (requests.length === 1) {
              if (failureMode === "thrown") throw new Error("Response lost after commit");
              return {
                ok: false,
                error: {
                  code: failureMode === "rejected" ? "revision_conflict" : "unknown",
                  message: "Response lost after commit",
                  retryable: true,
                },
              };
            }
            return receipt(structuralEdit({ operationKind: "inverse" }));
          }
          if (
            request.operation.kind === "apply_structural_edit" &&
            request.operation.command.kind === "release_history"
          ) {
            released.push(
              ...request.operation.command.tokens.map((item) => item.recipeOperationId),
            );
          }
          return receipt(structuralEdit({ operationKind: "release_history" }));
        },
      });
      try {
        await transfer(session, document.guid);
        session.handleKeyDown({ key: "z", metaKey: true } as KeyboardEvent);
        await session.whenIdle();
        await session.recoverHistory();
        expect(errors).toEqual(["Response lost after commit"]);
        expect(requests).toHaveLength(2);
        if (failureMode === "rejected")
          expect(requests[1]!.operationId).not.toBe(requests[0]!.operationId);
        else expect(requests[1]).toEqual(requests[0]);
        await session.close();
        expect(released).toEqual(["recipe:inverse"]);
      } finally {
        await session.close();
        undoManager.destroy();
        document.destroy();
      }
    },
  );

  test("cuts only after native clipboard verification and pastes through Core", async () => {
    const events: string[] = [];
    const commands: unknown[] = [];
    const document = new Y.Doc();
    const undoManager = new Y.UndoManager(document.getArray("history"));
    const blocks = new Map([
      ["text", { id: "text", type: "paragraph" }],
      ["page", { id: "page", type: "page" }],
      ["after", { id: "after", type: "paragraph" }],
      ["pasted", { id: "pasted", type: "page" }],
      ["toggle", { id: "toggle", type: "toggleListItem" }],
    ]);
    let selectedBlocks = [blocks.get("text")!, blocks.get("page")!];
    let selectedPmSelection: Selection | null = null;
    const cursorPlacements: unknown[] = [];
    const portableReplacements: unknown[] = [];
    const clipboardSettlements: Array<{
      readonly outcome: string;
      readonly cursorPlacementCount: number;
    }> = [];
    const editor = {
      getExtension: () => ({
        undoManager,
        fragment: document.getXmlFragment("body"),
        bindHistory: () => () => undefined,
        getSemanticSelection: () => undefined,
        restoreSemanticSelection: () => false,
      }),
      document: [blocks.get("text"), blocks.get("page"), blocks.get("after")],
      getSelection: () => (selectedBlocks.length > 0 ? { blocks: selectedBlocks } : undefined),
      getTextCursorPosition: () => ({
        block: blocks.get("text"),
        nextBlock: blocks.get("after"),
      }),
      getParentBlock: () => undefined,
      getBlock: (blockId: string) => blocks.get(blockId),
      setTextCursorPosition: (blockId: string, edge: string) => {
        cursorPlacements.push({ blockId, edge });
      },
      replaceBlocks: (blockIds: readonly string[], replacement: readonly unknown[]) => {
        portableReplacements.push({ blockIds, replacement });
        return [];
      },
      focus: () => undefined,
      prosemirrorView: {
        get state() {
          return {
            selection: selectedPmSelection ?? ({ nodes: [] } as unknown as Selection),
          };
        },
      },
      prosemirrorState: {
        plugins: [
          {
            key: "y-undo$test",
            getState: () => ({ undoManager }),
          },
        ],
      },
    } as unknown as BlockNoteEditor<any, any, any>;
    const apply: typeof applyLibraryModule = async (_accessContext, request) => {
      const operation = request.operation;
      commands.push(operation);
      if (operation.kind === "reverse_structural_edit") {
        events.push("reverse");
        return receipt(structuralEdit({ operationKind: "reverse_structural_edit" }));
      }
      if (operation.kind !== "apply_structural_edit") {
        throw new Error("Unexpected non-structural test operation");
      }
      const command = operation.command;
      events.push(command.kind);
      if (command.kind === "capture_clipboard") {
        return receipt(structuralEdit({ operationKind: command.kind, clipboard }));
      }
      if (command.kind === "paste_clipboard") {
        return receipt(
          structuralEdit({ operationKind: command.kind, resultRootBlockIds: ["pasted"] }),
        );
      }
      if (command.kind === "replace_selection") {
        return receipt(
          structuralEdit({ operationKind: command.kind, resultRootBlockIds: ["pasted"] }),
        );
      }
      if (command.kind === "duplicate_selection") {
        return receipt(
          structuralEdit({ operationKind: command.kind, resultRootBlockIds: ["pasted"] }),
        );
      }
      if (command.kind === "release_history") {
        return receipt({
          ...structuralEdit({ operationKind: command.kind }),
          history: null,
        });
      }
      if (command.kind === "move_selection") {
        return receipt(
          structuralEdit({
            operationKind: command.kind,
            resumeBlockId: "after",
          }),
        );
      }
      return receipt(structuralEdit({ operationKind: command.kind, resumeBlockId: "after" }));
    };
    let supersedeNextWrite = false;
    const writtenTexts: string[] = [];
    const beginClipboard: typeof beginStructuralClipboard = async () => ({ ok: true });
    const publishClipboard: typeof publishStructuralClipboard = async (input) => {
      events.push(`write:${input.envelope.actionHint}`);
      writtenTexts.push(input.text);
      if (supersedeNextWrite) {
        supersedeNextWrite = false;
        return { ok: false, failure: "superseded" };
      }
      return { ok: true };
    };
    const settleClipboard: typeof settleStructuralClipboard = async (input) => {
      clipboardSettlements.push({
        outcome: input.outcome,
        cursorPlacementCount: cursorPlacements.length,
      });
      return { ok: true };
    };
    const awaitedClaims: string[] = [];
    const awaitClipboard: typeof awaitStructuralClipboard = async (input) => {
      awaitedClaims.push(input.writeClaim);
      return {
        kind: "ready",
        disposition: "structural",
        envelope: input.publishedEnvelope ?? {
          version: 1,
          profileId: "profile:test",
          libraryId: "library:test",
          storeEpoch: clipboard.storeEpoch,
          bundleId: clipboard.bundleId,
          capability: clipboard.capability,
          manifestHash: clipboard.manifestHash,
          actionHint: "copy",
        },
      };
    };
    const session = new NfmStructuralEditingSession({
      historyReconciliation: availableHistoryReconciliation,
      editor,
      runtime: {
        accessContext: { kind: "project", projectId: "project:test" },
        libraryId: "library:test",
        source: { documentId: "document:test", storeEpoch: "epoch:test", generation: 1 },
        participant: {
          prepareAndFence: async () => {
            events.push("fence");
            return {
              documentId: "document:test",
              storeEpoch: "epoch:test",
              generation: 1,
              expectedHeadSeq: 3,
            };
          },
        },
        // This contract fixture includes mounted selection presentation; hidden
        // replay is exercised with a real detached EditorView in Chromium.
        getContainer: () =>
          ({
            isConnected: true,
            contains: () => false,
            ownerDocument: {
              activeElement: {},
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
            },
          }) as unknown as HTMLElement,
        resolveClipboardText: async (portableText) => `local:${portableText}`,
      },
      apply,
      beginClipboard,
      publishClipboard,
      settleClipboard,
      awaitClipboard,
    });

    try {
      const copyWriteClaim = writeClaim(1);
      expect(
        session.handleClipboard(
          "copy",
          ["text", "page"],
          { html: "<p>Fallback</p>", text: "Fallback" },
          copyWriteClaim,
        ),
      ).toBe(true);
      expect(
        session.handleStructuralClaimPaste(
          {
            version: 1,
            phase: "preparing",
            writeClaim: copyWriteClaim,
            actionHint: "copy",
          },
          [{ id: "portable", type: "paragraph", props: {}, content: [], children: [] }],
        ),
      ).toBe(true);
      selectedBlocks = [];
      await session.whenIdle();
      expect(events).toEqual([
        "fence",
        "capture_clipboard",
        "write:copy",
        "fence",
        "replace_selection",
      ]);
      expect(writtenTexts[0]).toBe("local:Fallback");
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "replace_selection",
          selection: { rootBlockIds: ["text", "page"] },
        },
      });
      events.length = 0;
      selectedBlocks = [];
      selectedPmSelection = atomicContentSelection("page");
      expect(session.hasTypedOwnerSelection()).toBe(true);
      expect(
        session.handleClipboard(
          "copy",
          ["page"],
          { html: "<p>Page</p>", text: "Page" },
          writeClaim(2),
        ),
      ).toBe(true);
      await session.whenIdle();
      expect(events).toEqual(["fence", "capture_clipboard", "write:copy"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "capture_clipboard",
          selection: { rootBlockIds: ["page"] },
        },
      });

      events.length = 0;
      expect(
        session.handlePaste({
          version: 1,
          profileId: "profile:test",
          libraryId: "library:test",
          storeEpoch: "epoch:test",
          bundleId: clipboard.bundleId,
          capability: clipboard.capability,
          manifestHash: clipboard.manifestHash,
          actionHint: "copy",
        }),
      ).toBe(true);
      await session.whenIdle();
      expect(events).toEqual(["fence", "replace_selection"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "replace_selection",
          selection: { rootBlockIds: ["page"] },
        },
      });

      events.length = 0;
      selectedPmSelection = null;
      selectedBlocks = [blocks.get("text")!, blocks.get("page")!];
      const cursorPlacementCountBeforeCut = cursorPlacements.length;
      expect(
        session.handleClipboard(
          "cut",
          ["text", "page"],
          { html: "<p>Fallback</p>", text: "Fallback" },
          writeClaim(3),
        ),
      ).toBe(true);
      await session.whenIdle();
      expect(events).toEqual([
        "fence",
        "capture_clipboard",
        "write:cut",
        "fence",
        "delete_selection",
      ]);
      expect(commands.at(-1)).toMatchObject({
        command: { reason: { kind: "cut", bundle: clipboard } },
      });
      expect(clipboardSettlements.at(-1)).toEqual({
        outcome: "cut_committed",
        cursorPlacementCount: cursorPlacementCountBeforeCut,
      });
      expect(cursorPlacements.length).toBeGreaterThan(cursorPlacementCountBeforeCut);

      events.length = 0;
      supersedeNextWrite = true;
      expect(
        session.handleClipboard(
          "copy",
          ["text", "page"],
          { html: "<p>Fallback</p>", text: "Fallback" },
          writeClaim(4),
        ),
      ).toBe(true);
      expect(
        session.handleStructuralClaimPaste(
          {
            version: 1,
            phase: "ready",
            writeClaim: writeClaim(4),
            actionHint: "copy",
            envelope: {
              version: 1,
              profileId: "profile:test",
              libraryId: "library:test",
              storeEpoch: clipboard.storeEpoch,
              bundleId: clipboard.bundleId,
              capability: clipboard.capability,
              manifestHash: clipboard.manifestHash,
              actionHint: "copy",
            },
          },
          [{ id: "portable", type: "paragraph", props: {}, content: [], children: [] }],
        ),
      ).toBe(true);
      await session.whenIdle();
      expect(awaitedClaims).toEqual([copyWriteClaim, writeClaim(4)]);
      expect(events).toEqual([
        "fence",
        "capture_clipboard",
        "write:copy",
        "fence",
        "replace_selection",
      ]);
      expect(cursorPlacements).toContainEqual({ blockId: "after", edge: "end" });

      events.length = 0;
      expect(
        session.handlePaste({
          version: 1,
          profileId: "profile:test",
          libraryId: "library:foreign",
          storeEpoch: "epoch:test",
          bundleId: clipboard.bundleId,
          capability: clipboard.capability,
          manifestHash: clipboard.manifestHash,
          actionHint: "cut",
        }),
      ).toBe(false);
      expect(events).toEqual([]);

      expect(
        session.handlePaste({
          version: 1,
          profileId: "profile:test",
          libraryId: "library:test",
          storeEpoch: "epoch:test",
          bundleId: clipboard.bundleId,
          capability: clipboard.capability,
          manifestHash: clipboard.manifestHash,
          actionHint: "cut",
        }),
      ).toBe(true);
      await session.whenIdle();
      expect(events).toEqual(["fence", "replace_selection"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "replace_selection",
          selection: { rootBlockIds: ["text", "page"] },
          replacement: { kind: "clipboard", bundle: clipboard },
        },
      });
      expect(cursorPlacements).toContainEqual({ blockId: "pasted", edge: "end" });

      events.length = 0;
      expect(
        session.handleBlockPaste([{ id: "external", type: "paragraph", props: {}, content: [] }]),
      ).toBe(true);
      await session.whenIdle();
      expect(events).toEqual(["fence", "replace_selection"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "replace_selection",
          replacement: {
            kind: "blocks",
            blocks: [{ blockType: "paragraph", content: [] }],
          },
        },
      });

      events.length = 0;
      expect(
        session.handleBeforeInput({
          inputType: "insertText",
          data: "x",
          isComposing: false,
        } as InputEvent),
      ).toBe(true);
      await session.whenIdle();
      expect(events).toEqual(["fence", "replace_selection"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          replacement: {
            kind: "blocks",
            blocks: [
              {
                blockType: "paragraph",
                content: [{ type: "text", text: "x", styles: {} }],
              },
            ],
          },
        },
      });

      events.length = 0;
      expect(session.duplicateBlocks(["text", "page"])).toBe(true);
      await session.whenIdle();
      expect(events).toEqual(["fence", "duplicate_selection"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "duplicate_selection",
          selection: { rootBlockIds: ["text", "page"] },
          target: { beforeBlockId: "after" },
        },
      });

      events.length = 0;
      expect(session.turnBlocksInto(["text"], ["text", "page"], { kind: "toggle_list" })).toBe(
        true,
      );
      await session.whenIdle();
      expect(events).toEqual(["fence", "turn_selection_into"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "turn_selection_into",
          selection: { rootBlockIds: ["text"] },
          target: { kind: "toggle_list" },
        },
      });
      expect(cursorPlacements).toContainEqual({ blockId: "after", edge: "end" });

      events.length = 0;
      expect(
        session.moveBlocksToDocument(["text", "page"], async () => ({
          documentId: "document:target",
          storeEpoch: "epoch:test",
          generation: 2,
          headSeq: 9,
        })),
      ).toBe(true);
      await session.whenIdle();
      expect(events).toEqual(["fence", "move_selection"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "move_selection",
          selection: { rootBlockIds: ["text", "page"] },
          target: {
            targetDocumentId: "document:target",
            targetHead: { generation: 2, expectedHeadSeq: 9 },
          },
        },
      });

      events.length = 0;
      expect(
        session.moveBlocksToDocument(["text"], async () => ({
          documentId: "document:target",
          storeEpoch: "epoch:test",
          generation: 2,
          headSeq: 9,
        })),
      ).toBe(true);
      await session.whenIdle();
      expect(events).toEqual(["fence", "move_selection"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "move_selection",
          selection: { rootBlockIds: ["text"] },
          target: {
            targetDocumentId: "document:target",
            targetHead: { generation: 2, expectedHeadSeq: 9 },
          },
        },
      });

      await transfer(session, "document:test", "toggle");
      await session.whenIdle();
      expect(cursorPlacements.at(-1)).toEqual({ blockId: "toggle", edge: "end" });

      session.rebind({
        accessContext: { kind: "project", projectId: "project:test" },
        libraryId: "library:test",
        source: { documentId: "document:test", storeEpoch: "epoch:test", generation: 1 },
        participant: {
          prepareAndFence: async () => {
            events.push("rebound:fence");
            return {
              documentId: "document:test",
              storeEpoch: "epoch:test",
              generation: 1,
              expectedHeadSeq: 4,
            };
          },
        },
        getContainer: () => null,
      });
      events.length = 0;
      expect(session.duplicateBlocks(["page"])).toBe(true);
      await session.whenIdle();
      expect(events).toEqual(["rebound:fence", "duplicate_selection"]);
      expect(commands.at(-1)).toMatchObject({
        command: {
          kind: "duplicate_selection",
          selection: { rootBlockIds: ["page"] },
        },
      });

      selectedBlocks = [blocks.get("text")!, blocks.get("page")!];
      expect(
        session.handleStructuralClaimPaste(
          {
            version: 1,
            phase: "ready",
            writeClaim: writeClaim(5),
            actionHint: "copy",
            envelope: {
              version: 1,
              profileId: "profile:foreign",
              libraryId: "library:foreign",
              storeEpoch: clipboard.storeEpoch,
              bundleId: clipboard.bundleId,
              capability: clipboard.capability,
              manifestHash: clipboard.manifestHash,
              actionHint: "copy",
            },
          },
          [
            {
              id: "portable-image",
              type: "image",
              props: { url: "nodex://files/file-foreign", name: "diagram.png" },
              content: [],
              children: [],
            },
          ],
        ),
      ).toBe(true);
      selectedBlocks = [];
      await session.whenIdle();
      expect(portableReplacements).toEqual([]);
      expect(commands.at(-1)).toMatchObject({
        kind: "apply_structural_edit",
        command: {
          kind: "replace_selection",
          selection: { rootBlockIds: ["text", "page"] },
          replacement: {
            kind: "blocks",
            blocks: [
              {
                blockType: "paragraph",
                props: {},
                content: [{ type: "text", text: "diagram.png", styles: {} }],
                children: [],
              },
            ],
          },
        },
      });
    } finally {
      session.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("keeps editor-installed callbacks live across retained view remounts", async () => {
    const document = new Y.Doc();
    const undoManager = new Y.UndoManager(document.getArray("history"));
    const editor = {
      getExtension: () => ({
        undoManager,
        fragment: document.getXmlFragment("body"),
        bindHistory: () => () => undefined,
        getSemanticSelection: () => undefined,
        restoreSemanticSelection: () => false,
      }),
      prosemirrorState: {
        plugins: [
          {
            key: "y-undo$controller",
            getState: () => ({ undoManager }),
          },
        ],
      },
    } as unknown as BlockNoteEditor<any, any, any>;
    const controller = new NfmStructuralEditingController(availableHistoryReconciliation);
    const session = controller.attachEditor(editor);
    const installedCallback = () => controller.current;
    const runtime = {
      accessContext: { kind: "project" as const, projectId: "project:test" },
      libraryId: "library:test",
      source: { documentId: "document:test", storeEpoch: "epoch:test", generation: 1 },
      participant: {
        prepareAndFence: async () => ({
          documentId: "document:test",
          storeEpoch: "epoch:test",
          generation: 1,
          expectedHeadSeq: 1,
        }),
      },
      getContainer: () => null,
    };

    try {
      controller.activate(session, runtime);
      expect(installedCallback()).toBe(session);

      controller.deactivate(session);
      expect(installedCallback()).toBeNull();

      controller.activate(session, { ...runtime, getContainer: () => null });
      expect(installedCallback()).toBe(session);
      expect(controller.attachEditor(editor)).toBe(session);
      expect(() => controller.attachEditor({} as BlockNoteEditor<any, any, any>)).toThrow(
        "cannot change its editor",
      );
    } finally {
      await controller.dispose();
      undoManager.destroy();
      document.destroy();
    }
    expect(installedCallback()).toBeNull();
  });
});

test("eviction during inverse preparation prevents a late Core submission", async () => {
  const document = new Y.Doc();
  const manager = new Y.UndoManager(document.getArray("history"));
  const history = new NfmHistoryLane({ undoManager: manager, limits: { maxEntries: 1 } });
  let resume = () => {};
  const preparation = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let started = () => {};
  const preparing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let inverses = 0;
  const editor = {
    getExtension: () => ({
      undoManager: manager,
      fragment: document.getXmlFragment("body"),
      bindHistory: () => () => undefined,
      getSemanticSelection: () => undefined,
      restoreSemanticSelection: () => false,
    }),
  } as unknown as BlockNoteEditor<any, any, any>;
  const session = new NfmStructuralEditingSession({
    editor,
    historyLane: history,
    historyReconciliation: availableHistoryReconciliation,
    runtime: {
      accessContext: { kind: "library" },
      libraryId: "library:test",
      source: { documentId: "document:test", storeEpoch: "epoch:test", generation: 1 },
      getContainer: () => null,
      participant: {
        prepareAndFence: async () => {
          started();
          await preparation;
          return {
            documentId: "document:test",
            storeEpoch: "epoch:test",
            generation: 1,
            expectedHeadSeq: 1,
          };
        },
      },
    },
    apply: async (_access, request) => {
      if (request.operation.kind === "reverse_structural_edit") inverses++;
      if (
        request.operation.kind === "apply_structural_edit" &&
        request.operation.command.kind === "move_selection"
      )
        return receipt(structuralEdit({ operationKind: "A" }));
      return receipt({ ...structuralEdit({ operationKind: "release" }), history: null });
    },
  });
  try {
    await transfer(session);
    history.requestUndo();
    await preparing;
    document.getArray("history").push(["B"]);
    resume();
    await history.whenIdle();
    expect(inverses).toBe(0);
    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(true);
  } finally {
    resume();
    await history.close();
    await session.close();
    manager.destroy();
    document.destroy();
  }
});

test("cancelling a structural preparation releases the queue and prevents late submission", async () => {
  const document = new Y.Doc();
  const undoManager = new Y.UndoManager(document.getArray("history"));
  const owner = { id: "page", type: "page" };
  const editor = {
    document: [owner],
    getBlock: () => owner,
    getParentBlock: () => undefined,
    focus: () => undefined,
    getExtension: () => ({
      undoManager,
      fragment: document.getXmlFragment("body"),
      bindHistory: () => () => undefined,
      getSemanticSelection: () => undefined,
      restoreSemanticSelection: () => false,
    }),
  } as unknown as BlockNoteEditor<any, any, any>;
  let complete: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let preparations = 0;
  let submissions = 0;
  const errors: string[] = [];
  const session = new NfmStructuralEditingSession({
    historyReconciliation: availableHistoryReconciliation,
    editor,
    runtime: {
      accessContext: { kind: "library" },
      libraryId: "library:test",
      source: { documentId: "document:test", storeEpoch: "epoch:test", generation: 1 },
      getContainer: () => null,
      onError: (message) => errors.push(message),
      participant: {
        prepareAndFence: async () => {
          preparations += 1;
          if (preparations === 1) await pending;
          return {
            documentId: "document:test",
            storeEpoch: "epoch:test",
            generation: 1,
            expectedHeadSeq: 1,
          };
        },
      },
    },
    apply: async () => {
      submissions += 1;
      throw new Error("submitted after preparation");
    },
  });
  try {
    expect(session.duplicateBlocks(["page"])).toBe(true);
    await Promise.resolve();
    session.cancelPreparations();
    await session.whenIdle();
    expect(submissions).toBe(0);
    complete();
    await pending;
    await Promise.resolve();
    expect(submissions).toBe(0);
    expect(session.duplicateBlocks(["page"])).toBe(true);
    await session.whenIdle();
    expect(submissions).toBe(1);
    expect(errors).toEqual(["The structural edit was cancelled.", "submitted after preparation"]);
  } finally {
    complete();
    session.dispose();
    undoManager.destroy();
    document.destroy();
  }
});

test("history cannot cross authorization scopes or take over an active IME composition", () => {
  const document = new Y.Doc();
  const undoManager = new Y.UndoManager(document.getArray("history"));
  const editor = {
    prosemirrorView: { composing: true },
    getExtension: () => ({
      undoManager,
      fragment: document.getXmlFragment("body"),
      bindHistory: () => () => undefined,
      getSemanticSelection: () => undefined,
      restoreSemanticSelection: () => false,
    }),
  } as unknown as BlockNoteEditor<any, any, any>;
  const runtime = {
    accessContext: { kind: "library" as const },
    libraryId: "library:test",
    source: { documentId: "document:test", storeEpoch: "epoch:test", generation: 1 },
    getContainer: () => null,
    participant: {
      prepareAndFence: async () => ({
        documentId: "document:test",
        storeEpoch: "epoch:test",
        generation: 1,
        expectedHeadSeq: 1,
      }),
    },
  };
  const session = new NfmStructuralEditingSession({
    editor,
    runtime,
    historyReconciliation: availableHistoryReconciliation,
  });
  try {
    expect(session.handleKeyDown({ key: "z", metaKey: true } as KeyboardEvent)).toBe(false);
    expect(session.handleBeforeInput({ inputType: "historyUndo" } as InputEvent)).toBe(false);
    expect(() =>
      session.rebind({ ...runtime, accessContext: { kind: "project", projectId: "other" } }),
    ).toThrow("cannot change its Document authority");
    expect(() => session.rebind({ ...runtime, libraryId: "another-library" })).toThrow(
      "cannot change its Document authority",
    );
  } finally {
    session.dispose();
    undoManager.destroy();
    document.destroy();
  }
});

test("refreshing an equivalent view binding preserves queued and active structural waits", async () => {
  const document = new Y.Doc();
  const undoManager = new Y.UndoManager(document.getArray("history"));
  const owner = { id: "page", type: "page" };
  const editor = {
    document: [owner],
    getBlock: () => owner,
    getParentBlock: () => undefined,
    focus: () => undefined,
    getExtension: () => ({
      undoManager,
      fragment: document.getXmlFragment("body"),
      bindHistory: () => () => undefined,
      getSemanticSelection: () => undefined,
      restoreSemanticSelection: () => false,
    }),
  } as unknown as BlockNoteEditor<any, any, any>;
  let complete = () => {};
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let preparations = 0;
  let submissions = 0;
  const errors: string[] = [];
  const runtime = {
    accessContext: { kind: "library" as const },
    libraryId: "library:test",
    source: { documentId: "document:test", storeEpoch: "epoch:test", generation: 1 },
    getContainer: () => null,
    onError: (message: string) => errors.push(message),
    participant: {
      prepareAndFence: async () => {
        preparations += 1;
        await pending;
        return {
          documentId: "document:test",
          storeEpoch: "epoch:test",
          generation: 1,
          expectedHeadSeq: 1,
        };
      },
    },
  };
  const session = new NfmStructuralEditingSession({
    historyReconciliation: availableHistoryReconciliation,
    editor,
    runtime,
    apply: async () => {
      submissions += 1;
      throw new Error("submission reached");
    },
  });
  try {
    expect(session.duplicateBlocks(["page"])).toBe(true);
    session.rebind({ ...runtime, accessContext: { kind: "library" } });
    await Promise.resolve();
    expect(preparations).toBe(1);
    session.rebind({ ...runtime, getContainer: () => null });
    expect(submissions).toBe(0);
    complete();
    await session.whenIdle();
    expect(submissions).toBe(1);
    expect(errors).toEqual(["submission reached"]);
  } finally {
    complete();
    session.dispose();
    undoManager.destroy();
    document.destroy();
  }
});
