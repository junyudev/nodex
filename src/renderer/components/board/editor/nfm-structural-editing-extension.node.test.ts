import type { BlockNoteEditor } from "@blocknote/core";
import { Schema } from "@tiptap/pm/model";
import { NodeSelection, type Selection } from "@tiptap/pm/state";
import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";

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
  readonly fileOwnershipMoves?: LibraryStructuralEditResult["fileOwnershipMoves"];
}) => ({
  operationKind: input.operationKind,
  sourceRootBlockIds: ["text", "page"],
  resultRootBlockIds: input.resultRootBlockIds ?? [],
  copiedBlockIds: {},
  copiedDocumentIds: {},
  documentCommits: [],
  affectedPageIds: ["page"],
  affectedDatabaseIds: [],
  fileOwnershipMoves: input.fileOwnershipMoves ?? [],
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

describe("NFM structural editing session", () => {
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
            fileOwnershipMoves: [
              {
                fileId: "file:image",
                previousOwnerPageId: "page:source",
                ownerPageId: "page:target",
                previousLogicalPath: "image.png",
                logicalPath: "image (2).png",
                version: 2,
              },
            ],
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
    const awaitClipboard: typeof awaitStructuralClipboard = async () => ({
      kind: "ready",
      disposition: "structural",
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
    });
    const ownershipMoves: LibraryStructuralEditResult["fileOwnershipMoves"][] = [];
    const session = new NfmStructuralEditingSession({
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
        getContainer: () => null,
        resolveClipboardText: async (portableText) => `local:${portableText}`,
        onFileOwnershipMoves: (moves) => ownershipMoves.push(moves),
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
        session.moveBlocksToDocument(["text", "page"], {
          documentId: "document:target",
          storeEpoch: "epoch:test",
          generation: 2,
          headSeq: 9,
        }),
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
      expect(ownershipMoves).toEqual([
        [
          expect.objectContaining({
            fileId: "file:image",
            logicalPath: "image (2).png",
          }),
        ],
      ]);

      session.adoptStructuralResult(
        structuralEdit({ operationKind: "move_selection", resultRootBlockIds: ["pasted"] }),
        "toggle",
      );
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
      expect(portableReplacements.at(-1)).toEqual({
        blockIds: ["text", "page"],
        replacement: [
          {
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "diagram.png", styles: {} }],
            children: [],
          },
        ],
      });
    } finally {
      session.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("keeps editor-installed callbacks live across retained view remounts", () => {
    const document = new Y.Doc();
    const undoManager = new Y.UndoManager(document.getArray("history"));
    const editor = {
      prosemirrorState: {
        plugins: [
          {
            key: "y-undo$controller",
            getState: () => ({ undoManager }),
          },
        ],
      },
    } as unknown as BlockNoteEditor<any, any, any>;
    const controller = new NfmStructuralEditingController();
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
      controller.dispose();
      undoManager.destroy();
      document.destroy();
    }
    expect(installedCallback()).toBeNull();
  });
});
