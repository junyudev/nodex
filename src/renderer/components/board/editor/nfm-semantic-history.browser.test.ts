import { BlockNoteEditor } from "@blocknote/core";
import type { YUndoExtension } from "@blocknote/core/yjs";
import { TextSelection } from "@tiptap/pm/state";
import { act } from "@testing-library/react";
import { expect, test, describe } from "vite-plus/test";
import * as Y from "yjs";
import {
  createPageDocumentGenesis,
  createCanonicalEmptyParagraphBlock,
  createDetachedPageDocumentFromBlockTree,
} from "../../../../shared/block-documents/block-document-codec";
import { cloneXmlSubtree } from "../../../../shared/block-documents/xml-subtree-codec";
import type {
  LibraryStructuralEditResult,
  LibraryModuleApplyResult,
} from "../../../../shared/library-module";
import type { applyLibraryModule } from "../../../lib/api";
import { publishDocumentHistoryFence } from "../../../lib/document-history-fence";
import { createNfmEditorModeOptions } from "./nfm-editor-source";
import {
  prepareNfmEditorForMutation,
  prepareNfmEditorStructuralMutation,
} from "./nfm-editor-relocation";
import { NfmStructuralEditingSession } from "./nfm-structural-editing-extension";
import { availableHistoryReconciliation } from "./testing/nfm-history-reconciliation";
import { userEvent } from "vite-plus/test/browser";
import {
  createInteractionHistory,
  type InteractionHistory,
} from "../../../lib/surface-history/owner";
import {
  dispatchFocusedHistory,
  readFocusedHistory,
  registerFocusedHistory,
} from "../../../lib/focused-history";
import { nfmSchema } from "./nfm-schema";
import { ownsNfmEditorEvent } from "./nfm-editor-event-owner";

describe("nfm semantic history selection", () => {
  const settle = async () =>
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  test("semantic Undo and Redo restore the original inline selections after address replacement and remount", async () => {
    const { document: doc } = createPageDocumentGenesis({
      documentId: "selection-history",
      markdown: "abcdef",
      allocateBlockId: () => "paragraph",
    });
    const body = doc.getXmlFragment("body");
    const group = body.get(0) as Y.XmlElement;
    const editor = BlockNoteEditor.create(
      createNfmEditorModeOptions({
        kind: "collaborative-document",
        documentId: doc.guid,
        storeEpoch: "epoch:history",
        generation: 1,
        clientSessionId: "surface:selection",
        fragment: body,
        user: { name: "History", color: "#2563eb" },
      }),
    );
    const host = document.createElement("div");
    const otherControl = document.createElement("button");
    otherControl.textContent = "Other surface";
    document.body.append(host, otherControl);
    const errors: string[] = [];
    let calls = 0;
    let moveFocusDuringCommit = false;
    const apply: typeof applyLibraryModule = async (_scope, request) => {
      const releasing =
        request.operation.kind === "apply_structural_edit" &&
        (request.operation.command.kind === "release_history" ||
          request.operation.command.kind === "set_local_history_retention");
      if (!releasing) {
        calls++;
        const text = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
        doc.transact(() => {
          text.delete(0, text.length);
          text.insert(0, calls % 2 === 1 ? "abcdef" : "abcXdef");
        }, "canonical-core");
        if (moveFocusDuringCommit) {
          otherControl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          otherControl.focus();
        }
      }
      const result: LibraryStructuralEditResult = {
        operationKind: "restore_editor_history",
        sourceRootBlockIds: ["paragraph"],
        resultRootBlockIds: ["paragraph"],
        copiedBlockIds: {},
        copiedDocumentIds: {},
        documentCommits: [],
        affectedPageIds: [],
        affectedDatabaseIds: [],
        clipboard: null,
        history: releasing
          ? null
          : {
              recipeOperationId: `recipe:${calls}`,
              recipeHash: "a".repeat(64),
              storeEpoch: "epoch:history",
            },
        supersededHistoryRecipeOperationIds: [],
        resume: null,
      };
      return {
        ok: true,
        localCommit: {
          status: "no_op",
          observed: { store_epoch: "epoch:history", commit_head: calls },
        },
        value: {
          operationId: request.operationId,
          profileId: "profile:history",
          storeEpoch: "epoch:history",
          libraryId: "library:history",
          operationKind: "apply_structural_edit",
          duplicate: false,
          didMutate: !releasing,
          createdTarget: null,
          canvasMutation: null,
          structuralEdit: result,
          affectedParentKeys: [],
          affectedPageIds: [],
          affectedDatabaseIds: [],
          affectedViewIds: [],
          committedRevisions: {},
          commitSeq: calls,
          committedAt: "2026-09-04T00:00:00.000Z",
        },
      };
    };
    const session = new NfmStructuralEditingSession({
      historyReconciliation: availableHistoryReconciliation,
      editor,
      apply,
      runtime: {
        routingContext: { kind: "library" },
        libraryId: "library:history",
        source: { documentId: doc.guid, generation: 1, storeEpoch: "epoch:history" },
        participant: {
          prepareAndFence: async () => {
            await prepareNfmEditorForMutation(editor, host);
            return {
              documentId: doc.guid,
              generation: 1,
              storeEpoch: "epoch:history",
              expectedHeadSeq: 1,
            };
          },
        },
        getContainer: () => host,
        onError: (error) => errors.push(error),
      },
    });
    try {
      await act(async () => {
        editor.mount(host);
        await settle();
        editor.setTextCursorPosition("paragraph", "start");
        const view = editor.prosemirrorView!;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, view.state.selection.from + 3),
          ),
        );
        view.dispatch(view.state.tr.insertText("X"));
        editor.getExtension<typeof YUndoExtension>("yUndo")!.undoManager.stopCapturing();
        const restored = cloneXmlSubtree(group.get(0) as Y.XmlElement);
        publishDocumentHistoryFence(doc, {
          headSeq: 1,
          blockIds: ["paragraph"],
          documentWide: false,
        });
        doc.transact(() => {
          group.delete(0, 1);
          group.insert(0, [restored]);
        }, "canonical-core");
        editor.unmount();
        editor.mount(host);
        await settle();
        editor.setTextCursorPosition("paragraph", "end");
        editor.focus();
        editor.undo();
        await session.whenIdle();
        await settle();
      });
      expect(errors).toEqual([]);
      expect(editor.getBlock("paragraph")?.content).toEqual([
        { type: "text", text: "abcdef", styles: {} },
      ]);
      expect(editor.prosemirrorView!.state.selection.$head.parentOffset).toBe(3);
      expect(editor.prosemirrorView!.hasFocus()).toBe(true);
      await act(async () => {
        editor.redo();
        await session.whenIdle();
        await settle();
      });
      expect(errors).toEqual([]);
      expect(editor.getBlock("paragraph")?.content).toEqual([
        { type: "text", text: "abcXdef", styles: {} },
      ]);
      expect(editor.prosemirrorView!.state.selection.$head.parentOffset).toBe(4);
      expect(editor.prosemirrorView!.hasFocus()).toBe(true);
      await act(async () => {
        moveFocusDuringCommit = true;
        editor.undo();
        await session.whenIdle();
        await settle();
      });
      expect(errors).toEqual([]);
      expect(editor.getBlock("paragraph")?.content).toEqual([
        { type: "text", text: "abcdef", styles: {} },
      ]);
      expect(document.activeElement).toBe(otherControl);
    } finally {
      await act(async () => {
        await session.close();
        editor.unmount();
        editor._tiptapEditor.destroy();
        await settle();
      });
      host.remove();
      otherControl.remove();
      doc.destroy();
    }
  });
});

describe("nfm content interaction history", () => {
  const content = (text: string) => [{ type: "text" as const, text, styles: {} }];
  const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const receipt = (
    request: Parameters<typeof applyLibraryModule>[1],
    structuralEdit: LibraryStructuralEditResult | null = null,
  ): Awaited<ReturnType<typeof applyLibraryModule>> => ({
    ok: true,
    localCommit: { status: "no_op", observed: { store_epoch: "epoch:realm", commit_head: 1 } },
    value: {
      operationId: request.operationId,
      profileId: "profile:realm",
      storeEpoch: "epoch:realm",
      libraryId: "library:realm",
      operationKind: "apply_structural_edit",
      duplicate: false,
      didMutate: true,
      createdTarget: null,
      canvasMutation: null,
      structuralEdit,
      affectedParentKeys: [],
      affectedPageIds: [],
      affectedDatabaseIds: [],
      affectedViewIds: [],
      committedRevisions: {},
      commitSeq: 1,
      committedAt: "2026-09-06T00:00:00.000Z",
    },
  });

  function surface(history: InteractionHistory, name: string, apply?: typeof applyLibraryModule) {
    const { document: doc } = createDetachedPageDocumentFromBlockTree({
      documentId: `document:realm-${name}`,
      blockTree: [{ ...createCanonicalEmptyParagraphBlock("edited"), content: content("Seed") }],
    });
    const host = document.createElement("div");
    host.className = "nfm-editor";
    document.body.append(host);
    const editor = BlockNoteEditor.create(
      createNfmEditorModeOptions(
        {
          kind: "collaborative-document",
          documentId: doc.guid,
          storeEpoch: "epoch:realm",
          generation: 1,
          clientSessionId: `surface:${name}`,
          transactionOrigin: { surface: name },
          fragment: doc.getXmlFragment("body"),
          user: { name, color: "#2563eb" },
        },
        { schema: nfmSchema },
      ),
    );
    // Keep all three edits inside one native capture window. No test callback
    // invokes the history lane's pre-capture hook: YUndo must do that itself.
    editor.getExtension<typeof YUndoExtension>("yUndo")!.undoManager.captureTimeout = 60_000;
    const errors: string[] = [];
    let mounted = true;
    let fences = 0;
    const session = new NfmStructuralEditingSession({
      editor,
      interactionHistory: history,
      apply: apply ?? (async (_scope, request) => receipt(request)),
      historyReconciliation: availableHistoryReconciliation,
      runtime: {
        routingContext: { kind: "library" },
        libraryId: "library:realm",
        source: { documentId: doc.guid, storeEpoch: "epoch:realm", generation: 1 },
        participant: {
          prepareAndFence: (options) =>
            prepareNfmEditorStructuralMutation(
              editor,
              mounted ? host : null,
              {
                flushAndFence: async () => {
                  fences++;
                  return {
                    documentId: doc.guid,
                    storeEpoch: "epoch:realm",
                    generation: 1,
                    expectedHeadSeq: 1,
                  };
                },
              },
              options,
            ),
        },
        getContainer: () => (mounted ? host : null),
        onError: (error) => errors.push(error),
      },
    });
    return {
      doc,
      host,
      editor,
      session,
      errors,
      get fences() {
        return fences;
      },
      hide() {
        mounted = false;
        editor.unmount();
        host.remove();
      },
      async close() {
        await session.close();
        editor._tiptapEditor.destroy();
        doc.destroy();
        host.remove();
      },
    };
  }

  test("actual YUndo delegates keep rapid interleaved Page edits in shared interaction order", async () => {
    const history = createInteractionHistory({ scopeKey: "realm" });
    const a = surface(history, "a");
    const b = surface(history, "b");
    try {
      await act(async () => {
        a.editor.mount(a.host);
        b.editor.mount(b.host);
        await settle();
        a.editor.setTextCursorPosition("edited", "end");
        a.editor.insertInlineContent(" A");
        b.editor.setTextCursorPosition("edited", "end");
        b.editor.insertInlineContent(" B");
        a.editor.setTextCursorPosition("edited", "end");
        a.editor.insertInlineContent(" C");
        await settle();
      });
      const undo = async () =>
        act(async () => {
          expect(b.editor.undo()).toBe(true);
          await history.whenIdle();
          await settle();
        });
      await undo();
      expect(a.editor.getBlock("edited")?.content).toEqual(content("Seed A"));
      expect(b.editor.getBlock("edited")?.content).toEqual(content("Seed B"));
      await undo();
      expect(b.editor.getBlock("edited")?.content).toEqual(content("Seed"));
      await undo();
      expect(a.editor.getBlock("edited")?.content).toEqual(content("Seed"));
      await act(async () => {
        const group = a.doc.getXmlFragment("body").get(0) as Y.XmlElement;
        const text = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
        a.doc.transact(() => text.insert(text.length, " remote"), { remote: true });
        expect(b.editor.undo()).toBe(true);
        await history.whenIdle();
        await settle();
      });
      expect(a.editor.getBlock("edited")?.content).toEqual(content("Seed remote"));
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
    } finally {
      await act(async () => {
        await a.close();
        await b.close();
      });
      history.close();
    }
  });

  test("shared Undo replays a hidden retained Page through its semantic Document fence", async () => {
    const history = createInteractionHistory({ scopeKey: "hidden-realm" });
    let semanticReplays = 0;
    const a = surface(history, "hidden", async (_scope, request) => {
      const operation = request.operation;
      if (
        operation.kind !== "apply_structural_edit" ||
        operation.command.kind !== "restore_editor_history"
      )
        return receipt(request);
      semanticReplays++;
      expect(operation.command.patch.changes).toHaveLength(1);
      const group = a.doc.getXmlFragment("body").get(0) as Y.XmlElement;
      const text = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
      a.doc.transact(
        () => {
          text.delete(0, text.length);
          text.insert(0, "Seed");
        },
        { core: true },
      );
      return receipt(request, {
        operationKind: "reverse_structural_edit",
        sourceRootBlockIds: [],
        resultRootBlockIds: [],
        copiedBlockIds: {},
        copiedDocumentIds: {},
        documentCommits: [],
        affectedPageIds: [],
        affectedDatabaseIds: [],
        clipboard: null,
        history: {
          recipeOperationId: "redo-hidden",
          recipeHash: "a".repeat(64),
          storeEpoch: "epoch:realm",
        },
        supersededHistoryRecipeOperationIds: [],
        resume: null,
      });
    });
    const b = surface(history, "visible");
    try {
      await act(async () => {
        a.editor.mount(a.host);
        b.editor.mount(b.host);
        await settle();
        a.editor.updateBlock("edited", { content: "Seed A" });
        const group = a.doc.getXmlFragment("body").get(0) as Y.XmlElement;
        const replacement = cloneXmlSubtree(group.get(0));
        publishDocumentHistoryFence(a.doc, {
          headSeq: 1,
          blockIds: ["edited"],
          documentWide: false,
        });
        a.doc.transact(
          () => {
            group.delete(0, 1);
            group.insert(0, [replacement]);
          },
          { core: true },
        );
        await settle();
        a.hide();
        b.editor.focus();
        expect(b.editor.undo()).toBe(true);
        await history.whenIdle();
        await settle();
      });
      expect(semanticReplays).toBe(1);
      expect(a.fences).toBe(1);
      const group = a.doc.getXmlFragment("body").get(0) as Y.XmlElement;
      const restoredText = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(
        0,
      ) as Y.XmlText;
      expect(restoredText.toString()).toBe("Seed");
      expect(document.activeElement).toBe(b.editor.prosemirrorView!.dom);
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
    } finally {
      await act(async () => {
        await a.close();
        await b.close();
      });
      history.close();
    }
  });

  test("foreign history fences preserve the invoking editor focus without overriding a later choice", async () => {
    const history = createInteractionHistory({ scopeKey: "foreign-focus" });
    const source = surface(history, "foreign-focus-source");
    const other = document.createElement("button");
    other.textContent = "Another action";
    document.body.append(other);
    let value = true;
    let pause: Promise<void> | undefined;
    let enteredFence: (() => void) | undefined;
    const foreign = history.bind<"move", never, boolean, boolean>({
      adapter: {
        describe: () => "Move Blocks",
        prepare: async () => {
          throw new Error("This fixture records an already committed move.");
        },
        prepareInverse: async (next) => {
          await prepareNfmEditorStructuralMutation(source.editor, source.host, {
            flushAndFence: async () => {
              enteredFence?.();
              await pause;
              return {
                documentId: source.doc.guid,
                storeEpoch: "epoch:realm",
                generation: 1,
                expectedHeadSeq: 1,
              };
            },
          });
          value = next;
          return { kind: "complete", receipt: next };
        },
        submit: async () => {
          throw new Error("The fixture has no remote request.");
        },
        interpret: (current) => ({ kind: "reversible", inverse: !current }),
      },
    });
    try {
      await act(async () => {
        source.editor.mount(source.host);
        await settle();
        foreign.capture("move", true);
        source.editor.focus();
        source.editor.prosemirrorView!.dom.blur();
        expect(document.activeElement).toBe(document.body);
        expect(source.editor.undo()).toBe(true);
        await history.whenIdle();
        await settle();
      });
      expect(value).toBe(false);
      expect(document.activeElement).toBe(source.editor.prosemirrorView!.dom);
      await act(async () => {
        expect(source.editor.redo()).toBe(true);
        await history.whenIdle();
        await settle();
      });
      expect(value).toBe(true);
      expect(document.activeElement).toBe(source.editor.prosemirrorView!.dom);

      let releaseFence: () => void = () => undefined;
      pause = new Promise<void>((resolve) => {
        releaseFence = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enteredFence = resolve;
      });
      await act(async () => {
        try {
          expect(source.editor.undo()).toBe(true);
          await entered;
          other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          other.focus();
        } finally {
          releaseFence();
        }
        await history.whenIdle();
        await settle();
      });
      expect(value).toBe(false);
      expect(document.activeElement).toBe(other);
      expect(source.errors).toEqual([]);
    } finally {
      foreign.close();
      await act(async () => {
        await source.close();
      });
      history.close();
      other.remove();
    }
  });

  test.each(["keyboard", "menu", "native"] as const)(
    "%s history routed by focus restores the editor that a foreign replay blurred",
    async (input) => {
      const history = createInteractionHistory({ scopeKey: `routed-focus-${input}` });
      // As in a Workbench, another surface starts focus routing before this editor listens.
      const board = document.createElement("section");
      document.body.append(board);
      const releaseBoard = registerFocusedHistory(board, { controls: history });
      const source = surface(history, `routed-focus-${input}`);
      let value = true;
      const foreign = history.bind<"move", never, boolean, boolean>({
        adapter: {
          describe: () => "Move Blocks",
          prepare: async () => {
            throw new Error("The fixture starts from a committed move");
          },
          prepareInverse: async (next) => {
            await prepareNfmEditorStructuralMutation(source.editor, source.host, {
              flushAndFence: async () => ({
                documentId: source.doc.guid,
                storeEpoch: "epoch:realm",
                generation: 1,
                expectedHeadSeq: 1,
              }),
            });
            value = next;
            return { kind: "complete", receipt: next };
          },
          submit: async () => {
            throw new Error("No remote request is needed");
          },
          interpret: (current) => ({ kind: "reversible", inverse: !current }),
        },
      });
      let unregister: () => void = () => undefined;
      const modifier = navigator.platform.includes("Mac") ? "Meta" : "Control";
      const request = async (direction: "undo" | "redo") => {
        if (input === "menu") dispatchFocusedHistory(direction);
        if (input === "keyboard")
          await userEvent.keyboard(
            direction === "undo"
              ? `{${modifier}>}z{/${modifier}}`
              : `{${modifier}>}{Shift>}z{/Shift}{/${modifier}}`,
          );
        // Chromium's native Undo targets the editable root holding the selection, even unfocused.
        if (input === "native")
          source.editor.prosemirrorView!.dom.dispatchEvent(
            new InputEvent("beforeinput", {
              inputType: direction === "undo" ? "historyUndo" : "historyRedo",
              bubbles: true,
              cancelable: true,
            }),
          );
        await history.whenIdle();
        await settle();
      };
      try {
        await act(async () => {
          source.editor.mount(source.host);
          await settle();
          const root = source.editor.prosemirrorView!.dom;
          unregister = registerFocusedHistory(root, {
            controls: source.session.historyControls,
            contentEditableRoot: () => root,
          });
          foreign.capture("move", true);
          if (input === "native") (document.activeElement as HTMLElement | null)?.blur();
          else source.editor.focus();
          await request("undo");
        });
        expect(value).toBe(false);
        expect(document.activeElement).toBe(source.editor.prosemirrorView!.dom);
        await act(async () => {
          await request("redo");
        });
        expect(value).toBe(true);
        expect(document.activeElement).toBe(source.editor.prosemirrorView!.dom);
        expect(source.errors).toEqual([]);
      } finally {
        unregister();
        releaseBoard();
        board.remove();
        foreign.close();
        await act(async () => {
          await source.close();
        });
        history.close();
      }
    },
  );

  test.each(["keyboard", "menu"] as const)(
    "%s history input remains owned while a foreign inverse awaits its receipt",
    async (input) => {
      const history = createInteractionHistory({ scopeKey: "pending-focus" });
      const source = surface(history, "pending-focus-source");
      let value = true;
      let releaseReceipt: () => void = () => undefined;
      const receiptReady = new Promise<void>((resolve) => {
        releaseReceipt = resolve;
      });
      let entered: () => void = () => undefined;
      const contentChanged = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const foreign = history.bind<"move", never, boolean, boolean>({
        adapter: {
          describe: () => "Move Blocks",
          prepare: async () => {
            throw new Error("The fixture starts from a committed move");
          },
          prepareInverse: async (next) => {
            await prepareNfmEditorStructuralMutation(source.editor, source.host, {
              flushAndFence: async () => ({
                documentId: source.doc.guid,
                storeEpoch: "epoch:realm",
                generation: 1,
                expectedHeadSeq: 1,
              }),
            });
            value = next;
            entered();
            await receiptReady;
            return { kind: "complete", receipt: next };
          },
          submit: async () => {
            throw new Error("No remote request is needed");
          },
          interpret: (current) => ({ kind: "reversible", inverse: !current }),
        },
      });
      try {
        await act(async () => {
          source.editor.mount(source.host);
          await settle();
          foreign.capture("move", true);
          source.editor.focus();
          expect(source.editor.undo()).toBe(true);
          await contentChanged;
          expect(value).toBe(false);
          try {
            expect(readFocusedHistory()?.ownerId).toBe(history.snapshot().ownerId);
            if (input === "menu") dispatchFocusedHistory("redo");
            else {
              const modifier = navigator.platform.includes("Mac") ? "Meta" : "Control";
              await userEvent.keyboard(`{${modifier}>}{Shift>}z{/Shift}{/${modifier}}`);
            }
          } finally {
            releaseReceipt();
          }
          await history.whenIdle();
          await settle();
        });
        expect(value).toBe(true);
        expect(source.errors).toEqual([]);
      } finally {
        releaseReceipt();
        foreign.close();
        await act(async () => {
          await source.close();
        });
        history.close();
      }
    },
  );
});

describe("nfm surface history", () => {
  const structuralResult = (id: string): LibraryStructuralEditResult => ({
    operationKind: "reverse_structural_edit",
    sourceRootBlockIds: [],
    resultRootBlockIds: [],
    copiedBlockIds: {},
    copiedDocumentIds: {},
    documentCommits: [],
    affectedPageIds: [],
    affectedDatabaseIds: [],
    clipboard: null,
    history: { recipeOperationId: id, recipeHash: "a".repeat(64), storeEpoch: "epoch:history" },
    supersededHistoryRecipeOperationIds: [],
    resume: null,
  });
  const libraryReceipt = (
    request: Parameters<typeof applyLibraryModule>[1],
    structuralEdit: LibraryStructuralEditResult | null,
  ): LibraryModuleApplyResult => {
    return {
      ok: true,
      localCommit: { status: "no_op", observed: { store_epoch: "epoch:history", commit_head: 1 } },
      value: {
        operationId: request.operationId,
        profileId: "profile:history",
        storeEpoch: "epoch:history",
        libraryId: "library:history",
        operationKind: "apply_structural_edit",
        duplicate: false,
        didMutate: true,
        createdTarget: null,
        canvasMutation: null,
        structuralEdit,
        affectedParentKeys: [],
        affectedPageIds: [],
        affectedDatabaseIds: [],
        affectedViewIds: [],
        committedRevisions: {},
        commitSeq: 1,
        committedAt: "2026-09-04T00:00:00.000Z",
      },
    };
  };

  const settle = async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  };

  test("two surfaces sharing one Y.Doc preserve independent text history after structural restoration", async () => {
    const textContent = (text: string) => [{ type: "text", text, styles: {} }];
    const { document: doc } = createDetachedPageDocumentFromBlockTree({
      documentId: "document:shared-surface-history",
      blockTree: [
        {
          ...createCanonicalEmptyParagraphBlock("edited"),
          content: textContent("Before"),
          children: [{ id: "owned-page", type: "page", props: {}, children: [] }],
        },
        {
          ...createCanonicalEmptyParagraphBlock("independent"),
          content: textContent("Independent"),
        },
      ],
    });
    // These editors share this exact in-memory fragment, not synchronized replicas.
    const fragment = doc.getXmlFragment("body");
    const group = fragment.get(0) as Y.XmlElement;
    const canonicalOrigin = Object.freeze({ kind: "canonical-core-delivery" });
    let deletedSubtree: ReturnType<typeof cloneXmlSubtree> | undefined;
    let commitHead = 0;
    let semanticUndos = 0;
    const errors: string[] = [];
    const setEditedText = (value: string) => {
      const container = group.get(0) as Y.XmlElement;
      const text = (container.get(0) as Y.XmlElement).get(0) as Y.XmlText;
      doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, value);
      }, canonicalOrigin);
    };
    // Only the Core transport is a fixture. Both sessions, history owners, Yjs
    // managers, journals and semantic-address recovery remain production code.
    const apply: typeof applyLibraryModule = async (_scope, request) => {
      const operation = request.operation;
      if (operation.kind === "apply_structural_edit") {
        const command = operation.command;
        if (command.kind === "release_history" || command.kind === "set_local_history_retention")
          return libraryReceipt(request, null);
        if (command.kind === "delete_selection") {
          expect(command.selection.rootBlockIds).toEqual(["edited"]);
          deletedSubtree = cloneXmlSubtree(group.get(0));
          publishDocumentHistoryFence(doc, {
            headSeq: ++commitHead,
            blockIds: ["edited", "owned-page"],
            documentWide: false,
          });
          doc.transact(() => group.delete(0, 1), canonicalOrigin);
          return libraryReceipt(request, structuralResult("restore-shared-subtree"));
        }
        if (command.kind === "restore_editor_history") {
          expect(command.documentId).toBe(doc.guid);
          expect(
            command.patch.changes.map(({ blockId, before, after }) => ({
              blockId,
              before: before?.content,
              after: after?.content,
            })),
          ).toEqual([
            { blockId: "edited", before: textContent("Before"), after: textContent("Before A") },
          ]);
          semanticUndos++;
          setEditedText("Before");
          return libraryReceipt(request, structuralResult("redo-shared-text"));
        }
      }
      if (operation.kind === "reverse_structural_edit") {
        if (operation.token.recipeOperationId === "restore-shared-subtree") {
          if (!deletedSubtree) throw new Error("The structural deletion was not captured.");
          publishDocumentHistoryFence(doc, {
            headSeq: ++commitHead,
            blockIds: ["edited", "owned-page"],
            documentWide: false,
          });
          doc.transact(() => group.insert(0, [deletedSubtree!]), canonicalOrigin);
          return libraryReceipt(request, structuralResult("delete-shared-subtree"));
        }
        if (operation.token.recipeOperationId === "redo-shared-text") {
          setEditedText("Before A");
          return libraryReceipt(request, structuralResult("undo-shared-text"));
        }
      }
      throw new Error(`Unexpected history request: ${JSON.stringify(operation)}`);
    };
    const surfaces = ["A", "B"].map((name) => {
      const host = document.createElement("div");
      host.className = "nfm-editor";
      document.body.append(host);
      const editor = BlockNoteEditor.create(
        createNfmEditorModeOptions(
          {
            kind: "collaborative-document",
            documentId: doc.guid,
            storeEpoch: "epoch:history",
            generation: 1,
            clientSessionId: `surface:shared-${name}`,
            transactionOrigin: Object.freeze({ surface: name }),
            fragment,
            user: { name, color: "#2563eb" },
          },
          { schema: nfmSchema },
        ),
      );
      const session = new NfmStructuralEditingSession({
        editor,
        apply,
        historyReconciliation: availableHistoryReconciliation,
        runtime: {
          routingContext: { kind: "library" },
          libraryId: "library:history",
          source: { documentId: doc.guid, storeEpoch: "epoch:history", generation: 1 },
          participant: {
            prepareAndFence: async () => ({
              documentId: doc.guid,
              storeEpoch: "epoch:history",
              generation: 1,
              expectedHeadSeq: commitHead,
            }),
          },
          getContainer: () => host,
          onError: (error) => errors.push(error),
        },
      });
      return { host, editor, session };
    });
    const [a, b] = surfaces;
    try {
      await act(async () => {
        for (const surface of surfaces) surface.editor.mount(surface.host);
        await settle();
        a.editor.updateBlock("edited", { content: "Before A" });
        a.session.stopCapturing();
        b.editor.updateBlock("independent", { content: "Independent B" });
        b.session.stopCapturing();
        await settle();
      });
      expect(a.editor.getBlock("independent")?.content).toEqual(textContent("Independent B"));
      expect(b.editor.getBlock("edited")?.content).toEqual(textContent("Before A"));
      await act(async () => {
        expect(b.session.deleteBlocks(["edited"], "backward")).toBe(true);
        await b.session.whenIdle();
        await settle();
      });
      for (const { editor } of surfaces) {
        expect(editor.getBlock("edited")).toBeUndefined();
        expect(editor.getBlock("owned-page")).toBeUndefined();
      }
      await act(async () => {
        expect(b.editor.undo()).toBe(true);
        await b.session.whenIdle();
        await settle();
      });
      for (const { editor } of surfaces) {
        expect(editor.getBlock("edited")?.content).toEqual(textContent("Before A"));
        expect(editor.getBlock("owned-page")?.type).toBe("page");
      }
      await act(async () => {
        expect(a.editor.undo()).toBe(true);
        await a.session.whenIdle();
        await settle();
      });
      expect(semanticUndos).toBe(1);
      for (const { editor } of surfaces) {
        expect(editor.getBlock("edited")?.content).toEqual(textContent("Before"));
        expect(editor.getBlock("independent")?.content).toEqual(textContent("Independent B"));
      }
      await act(async () => {
        expect(a.session.historyControls.snapshot().undo.acceptsIntent).toBe(false);
        expect(a.editor.redo()).toBe(true);
        await a.session.whenIdle();
        await settle();
        expect(b.editor.undo()).toBe(true);
        await b.session.whenIdle();
        await settle();
      });
      for (const { editor } of surfaces) {
        expect(editor.getBlock("edited")?.content).toEqual(textContent("Before A"));
        expect(editor.getBlock("independent")?.content).toEqual(textContent("Independent"));
        expect(editor.getBlock("owned-page")?.type).toBe("page");
      }
      expect(errors).toEqual([]);
    } finally {
      await act(async () => {
        for (const { session, editor } of surfaces) {
          await session.close();
          editor.unmount();
          editor._tiptapEditor.destroy();
        }
        await settle();
      });
      for (const { host } of surfaces) host.remove();
      doc.destroy();
    }
  });

  test("a surface created before mount undoes later text before structure through DOM and editor commands", async () => {
    const { document: doc } = createPageDocumentGenesis({
      documentId: "document:surface-history",
      title: "History",
      markdown: "",
      allocateBlockId: () => "block:paragraph",
    });
    const editor = BlockNoteEditor.create(
      createNfmEditorModeOptions({
        kind: "collaborative-document",
        documentId: doc.guid,
        storeEpoch: "epoch:history",
        generation: 1,
        clientSessionId: "surface:history",
        fragment: doc.getXmlFragment("body"),
        user: { name: "History", color: "#2563eb" },
      }),
    );
    const host = document.createElement("div");
    host.className = "nfm-editor";
    document.body.append(host);
    const reversed: string[] = [];
    const apply: typeof applyLibraryModule = async (_context, request) => {
      if (request.operation.kind === "reverse_structural_edit") {
        reversed.push(request.operation.token.recipeOperationId);
      }
      return libraryReceipt(
        request,
        structuralResult(
          request.operation.kind === "reverse_structural_edit"
            ? `inverse:${reversed.at(-1)}`
            : "cut:A",
        ),
      );
    };
    // Production attaches the retained session during render, before EditorView exists.
    const session = new NfmStructuralEditingSession({
      historyReconciliation: availableHistoryReconciliation,
      editor,
      apply,
      runtime: {
        routingContext: { kind: "library" },
        libraryId: "library:history",
        source: { documentId: doc.guid, storeEpoch: "epoch:history", generation: 1 },
        participant: {
          prepareAndFence: async () => ({
            documentId: doc.guid,
            storeEpoch: "epoch:history",
            generation: 1,
            expectedHeadSeq: 1,
          }),
        },
        getContainer: () => host,
      },
    });
    host.addEventListener(
      "keydown",
      (event) => {
        if (!ownsNfmEditorEvent(host, event.target)) return;
        if (!session.handleKeyDown(event)) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
    try {
      await act(async () => {
        editor.mount(host);
        await settle();
      });
      await act(async () => {
        const head = {
          documentId: doc.guid,
          storeEpoch: "epoch:history",
          generation: 1,
          expectedHeadSeq: 1,
        };
        await session.transferBlocks({
          mode: "move",
          rootBlockIds: ["block:paragraph"],
          prepareHeads: async () => ({ sourceHead: head, targetHead: head }),
          target: { parentBlockId: null, beforeBlockId: null },
        });
        editor.updateBlock("block:paragraph", { content: "B" });
        await settle();
        editor.unmount();
        editor.mount(host);
        await settle();
      });
      await act(async () => {
        editor.prosemirrorView!.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "z",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await settle();
      });
      expect(reversed).toEqual([]);
      expect(editor.getBlock("block:paragraph")?.content).toEqual([]);
      await act(async () => {
        expect(editor.undo()).toBe(true);
        await settle();
      });
      expect(reversed).toEqual(["cut:A"]);
      await act(async () => {
        expect(editor.redo()).toBe(true);
        await settle();
      });
      expect(reversed).toEqual(["cut:A", "inverse:cut:A"]);
      await act(async () => {
        expect(editor.redo()).toBe(true);
        await settle();
      });
      expect(editor.getBlock("block:paragraph")?.content).toEqual([
        { type: "text", text: "B", styles: {} },
      ]);
    } finally {
      await act(async () => {
        session.dispose();
        editor.unmount();
        editor._tiptapEditor.destroy();
        await settle();
      });
      host.remove();
      doc.destroy();
    }
  });

  test("portable fallback fills the reserved paste gesture even when Undo was queued before readiness", async () => {
    const { document: doc } = createPageDocumentGenesis({
      documentId: "portable-history",
      markdown: "",
      allocateBlockId: () => "paragraph",
    });
    const editor = BlockNoteEditor.create(
      createNfmEditorModeOptions({
        kind: "collaborative-document",
        documentId: doc.guid,
        storeEpoch: "epoch:history",
        generation: 1,
        clientSessionId: "surface:portable",
        fragment: doc.getXmlFragment("body"),
        user: { name: "History", color: "#2563eb" },
      }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const mutations: unknown[] = [];
    const session = new NfmStructuralEditingSession({
      editor,
      historyReconciliation: availableHistoryReconciliation,
      runtime: {
        routingContext: { kind: "library" },
        libraryId: "library:history",
        source: { documentId: doc.guid, storeEpoch: "epoch:history", generation: 1 },
        participant: {
          prepareAndFence: async () => ({
            documentId: doc.guid,
            storeEpoch: "epoch:history",
            generation: 1,
            expectedHeadSeq: 1,
          }),
        },
        getContainer: () => host,
      },
      awaitClipboard: async () => {
        await readiness;
        return { kind: "portable_fallback", reason: "source_closed" };
      },
      apply: async (_scope, request) => {
        const operation = request.operation;
        if (
          operation.kind !== "apply_structural_edit" ||
          !["release_history", "set_local_history_retention"].includes(operation.command.kind)
        )
          mutations.push(operation);
        return libraryReceipt(request, null);
      },
    });
    try {
      await act(async () => {
        editor.mount(host);
        editor.updateBlock("paragraph", { content: "Earlier" });
        editor.setTextCursorPosition("paragraph", "end");
        await settle();
      });
      await act(async () => {
        expect(
          session.handleStructuralClaimPaste(
            {
              version: 1,
              phase: "preparing",
              writeClaim: "0199134e-cbb0-7000-8000-000000000001",
              actionHint: "copy",
            },
            [
              {
                id: "portable",
                type: "paragraph",
                props: {},
                content: [{ type: "text", text: "Pasted", styles: {} }],
                children: [],
              },
            ],
          ),
        ).toBe(true);
        expect(editor.undo()).toBe(true);
        ready();
        await session.whenIdle();
        await settle();
      });
      expect(editor.document).toHaveLength(1);
      expect(editor.getBlock("paragraph")?.content).toEqual([
        { type: "text", text: "Earlier", styles: {} },
      ]);
      await act(async () => {
        expect(editor.redo()).toBe(true);
        await session.whenIdle();
        await settle();
      });
      expect(editor.document).toHaveLength(2);
      expect(editor.document[1]?.content).toEqual([{ type: "text", text: "Pasted", styles: {} }]);
      await act(async () => {
        editor.undo();
        await session.whenIdle();
        editor.undo();
        await session.whenIdle();
        await settle();
      });
      expect(editor.document).toHaveLength(1);
      expect(editor.getBlock("paragraph")?.content).toEqual([]);
      expect(mutations).toEqual([]);
    } finally {
      ready();
      await act(async () => {
        await session.close();
        editor.unmount();
        editor._tiptapEditor.destroy();
        await settle();
      });
      host.remove();
      doc.destroy();
    }
  });
});
