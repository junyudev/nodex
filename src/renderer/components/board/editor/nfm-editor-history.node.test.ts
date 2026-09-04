import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";

import type {
  LibraryStructuralEditResult,
  LibraryStructuralHistoryToken,
} from "../../../../shared/library-module";
import { NfmHistoryLane } from "./nfm-editor-history";

const digest = "a".repeat(64);
const token = (recipeOperationId: string): LibraryStructuralHistoryToken => ({
  recipeOperationId,
  recipeHash: digest,
  storeEpoch: "epoch:test",
});
const structuralResult = (
  history: LibraryStructuralHistoryToken,
  supersededHistoryRecipeOperationIds: readonly string[] = [],
): LibraryStructuralEditResult => ({
  operationKind: "reverse_structural_edit",
  sourceRootBlockIds: [],
  resultRootBlockIds: [],
  copiedBlockIds: {},
  copiedDocumentIds: {},
  documentCommits: [],
  affectedPageIds: [],
  affectedDatabaseIds: [],
  clipboard: null,
  history,
  supersededHistoryRecipeOperationIds,
  resume: null,
});
const settleReplay = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("NFM chronological history lane", () => {
  test("retains structural undo when a surface has no local Yjs history", async () => {
    const reversed: string[] = [];
    const lane = new NfmHistoryLane({
      reverseStructural: async (history) => {
        reversed.push(history.recipeOperationId);
        return {
          structuralEdit: structuralResult(token("redo-paste")),
        };
      },
    });

    try {
      lane.recordStructural(structuralResult(token("paste")));
      expect(lane.requestUndo()).toBe(true);
      await settleReplay();
      expect(reversed).toEqual(["paste"]);
      expect(lane.canRedo()).toBe(true);
    } finally {
      lane.dispose();
    }
  });

  test("undoes and redoes Yjs and Core edits in user action order", async () => {
    const document = new Y.Doc();
    const values = document.getArray<string>("values");
    const undoManager = new Y.UndoManager(values, { captureTimeout: 0 });
    const reversed: string[] = [];
    const lane = new NfmHistoryLane({
      undoManager,
      reverseStructural: async (history) => {
        reversed.push(history.recipeOperationId);
        return {
          structuralEdit: structuralResult(
            token(history.recipeOperationId === "delete" ? "redo-delete" : "undo-delete-again"),
          ),
        };
      },
    });

    try {
      values.push(["A"]);
      lane.recordStructural(structuralResult(token("delete")));
      values.push(["B"]);
      expect(values.toArray()).toEqual(["A", "B"]);

      expect(lane.requestUndo()).toBe(true);
      await settleReplay();
      expect(values.toArray()).toEqual(["A"]);

      expect(lane.requestUndo()).toBe(true);
      await settleReplay();
      expect(reversed).toEqual(["delete"]);

      expect(lane.requestUndo()).toBe(true);
      await settleReplay();
      expect(values.toArray()).toEqual([]);

      expect(lane.requestRedo()).toBe(true);
      await settleReplay();
      expect(values.toArray()).toEqual(["A"]);

      expect(lane.requestRedo()).toBe(true);
      await settleReplay();
      expect(reversed).toEqual(["delete", "redo-delete"]);

      expect(lane.requestRedo()).toBe(true);
      await settleReplay();
      expect(values.toArray()).toEqual(["A", "B"]);
    } finally {
      lane.dispose();
      undoManager.destroy();
      document.destroy();
    }
  });

  test("releases Core retention when a redo branch or surface becomes unreachable", async () => {
    const document = new Y.Doc();
    const values = document.getArray<string>("values");
    const undoManager = new Y.UndoManager(values, { captureTimeout: 0 });
    const released: string[][] = [];
    const lane = new NfmHistoryLane({
      undoManager,
      reverseStructural: async () => ({
        structuralEdit: structuralResult(token("redo-delete")),
      }),
      releaseStructural: async (tokens) => {
        released.push(tokens.map((candidate) => candidate.recipeOperationId));
      },
    });

    lane.recordStructural(structuralResult(token("delete")));
    expect(lane.requestUndo()).toBe(true);
    await settleReplay();
    values.push(["new branch"]);
    await settleReplay();
    expect(released).toEqual([["redo-delete"]]);

    lane.recordStructural(structuralResult(token("still-undoable")));
    lane.dispose();
    await settleReplay();
    expect(released.at(-1)).toEqual(["still-undoable"]);
    undoManager.destroy();
    document.destroy();
  });

  test("supersedes a cut entry retained by another editor surface", () => {
    const sourceDocument = new Y.Doc();
    const targetDocument = new Y.Doc();
    const sourceUndo = new Y.UndoManager(sourceDocument.getArray("source"));
    const targetUndo = new Y.UndoManager(targetDocument.getArray("target"));
    const source = new NfmHistoryLane({ undoManager: sourceUndo });
    const target = new NfmHistoryLane({ undoManager: targetUndo });

    try {
      source.recordStructural(structuralResult(token("cut-source")));
      expect(source.canUndo()).toBe(true);

      target.recordStructural(structuralResult(token("move-target"), ["cut-source"]));
      expect(source.canUndo()).toBe(false);
      expect(target.canUndo()).toBe(true);
    } finally {
      source.dispose();
      target.dispose();
      sourceUndo.destroy();
      targetUndo.destroy();
      sourceDocument.destroy();
      targetDocument.destroy();
    }
  });
});
