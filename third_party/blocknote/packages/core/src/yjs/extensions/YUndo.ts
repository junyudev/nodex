import { Plugin, type Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  getRelativeSelection,
  redoCommand,
  undoCommand,
  ySyncPluginKey,
  yUndoPluginKey,
} from "y-prosemirror";
import * as Y from "yjs";
import { createExtension, type ExtensionOptions } from "../../editor/BlockNoteExtension.js";

import {
  captureSurfaceHistorySelection,
  resolveSurfaceHistorySelection,
  type SurfaceHistorySelection,
  type SurfaceHistorySelectionPair,
} from "./semanticHistorySelection.js";
export type {
  SurfaceHistorySelection,
  SurfaceHistorySelectionPair,
} from "./semanticHistorySelection.js";

type RelativeSelection = ReturnType<typeof getRelativeSelection>;

interface SurfaceUndoPluginState {
  readonly undoManager: Y.UndoManager;
  readonly prevSel: RelativeSelection | null;
  readonly hasUndoOps: boolean;
  readonly hasRedoOps: boolean;
  readonly semanticSelection?: SurfaceHistorySelectionPair;
}

interface YSyncPluginState {
  readonly type: Y.AbstractType<unknown>;
  readonly binding?: Parameters<typeof getRelativeSelection>[0];
}

interface UndoStackItemEvent {
  readonly stackItem: {
    readonly meta: Map<unknown, unknown>;
  };
}

/** An editor-lifetime owner can route every history command through one lane. */
export interface SurfaceHistoryDelegate {
  canUndo(): boolean;
  canRedo(): boolean;
  requestUndo(): boolean;
  requestRedo(): boolean;
}

function createSurfaceUndoController(fragment: Y.XmlFragment, transactionOrigin: object) {
  // Register before EditorView exists: local history must never depend on mount order.
  const manager = new Y.UndoManager(fragment, {
    trackedOrigins: new Set([transactionOrigin]),
    deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
    captureTransaction: (transaction) => transaction.meta.get("addToHistory") !== false,
  });
  let disposed = false;
  let view: EditorView | undefined;
  const selections = new WeakMap<object, SurfaceHistorySelectionPair>();

  return {
    selections,
    attachView(next: EditorView): () => void {
      view = next;
      return () => {
        if (view === next) view = undefined;
      };
    },
    getSemanticSelection(item: object): SurfaceHistorySelectionPair | undefined {
      return selections.get(item);
    },
    restoreSemanticSelection(bookmark: SurfaceHistorySelection): boolean {
      if (!view || disposed) return false;
      const selection = resolveSurfaceHistorySelection(view.state, bookmark);
      if (!selection) return false;
      view.dispatch(view.state.tr.setSelection(selection));
      return true;
    },
    get(): Y.UndoManager {
      if (disposed) {
        throw new Error("Cannot use a disposed collaborative undo extension");
      }
      return manager;
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      manager.destroy();
    },
  };
}

function createSurfaceYUndoPlugin(
  controller: ReturnType<typeof createSurfaceUndoController>,
): Plugin<SurfaceUndoPluginState> {
  return new Plugin<SurfaceUndoPluginState>({
    key: yUndoPluginKey,
    state: {
      init: (_config, state) => {
        const syncState = ySyncPluginKey.getState(state) as YSyncPluginState | undefined;
        if (!syncState) {
          throw new Error("Collaborative undo requires the Yjs sync plugin");
        }

        return {
          get undoManager() {
            return controller.get();
          },
          prevSel: null,
          hasUndoOps: false,
          hasRedoOps: false,
        };
      },
      apply: (_transaction, value, oldState, state) => {
        const syncState = ySyncPluginKey.getState(state) as YSyncPluginState | undefined;
        const manager = value.undoManager;
        const hasUndoOps = manager.undoStack.length > 0;
        const hasRedoOps = manager.redoStack.length > 0;

        if (!syncState?.binding) {
          if (hasUndoOps === value.hasUndoOps && hasRedoOps === value.hasRedoOps) {
            return value;
          }
          return { ...value, hasUndoOps, hasRedoOps };
        }

        return {
          undoManager: manager,
          prevSel: getRelativeSelection(syncState.binding, oldState),
          semanticSelection: {
            before: captureSurfaceHistorySelection(oldState),
            after: captureSurfaceHistorySelection(state),
          },
          hasUndoOps,
          hasRedoOps,
        };
      },
    },
    view: (view) => {
      const syncState = ySyncPluginKey.getState(view.state) as YSyncPluginState | undefined;
      const undoState = yUndoPluginKey.getState(view.state) as SurfaceUndoPluginState | undefined;
      if (!syncState || !undoState) {
        throw new Error("Collaborative undo plugins are not initialized");
      }

      const manager = undoState.undoManager;
      const detachView = controller.attachView(view);
      const captureSemanticSelection = ({ stackItem }: UndoStackItemEvent): void => {
        const current = (yUndoPluginKey.getState(view.state) as SurfaceUndoPluginState | undefined)
          ?.semanticSelection;
        if (!current) return;
        const previous = controller.selections.get(stackItem);
        controller.selections.set(stackItem, {
          before: previous ? previous.before : current.before,
          after: current.after,
        });
      };
      const handleStackItemAdded = ({ stackItem }: UndoStackItemEvent): void => {
        const binding = syncState.binding;
        if (!binding) return;
        const current = yUndoPluginKey.getState(view.state) as SurfaceUndoPluginState | undefined;
        stackItem.meta.set(binding, current?.prevSel ?? null);
      };
      const handleStackItemPopped = ({ stackItem }: UndoStackItemEvent): void => {
        const binding = syncState.binding;
        if (!binding) return;
        binding.beforeTransactionSelection =
          (stackItem.meta.get(binding) as RelativeSelection | undefined) ??
          binding.beforeTransactionSelection;
      };

      manager.on("stack-item-added", handleStackItemAdded);
      manager.on("stack-item-added", captureSemanticSelection);
      manager.on("stack-item-updated", captureSemanticSelection);
      manager.on("stack-item-popped", handleStackItemPopped);

      return {
        destroy: () => {
          detachView();
          manager.off("stack-item-added", handleStackItemAdded);
          manager.off("stack-item-added", captureSemanticSelection);
          manager.off("stack-item-updated", captureSemanticSelection);
          manager.off("stack-item-popped", handleStackItemPopped);
        },
      };
    },
  });
}

export const YUndoExtension = createExtension(
  ({
    options,
  }: ExtensionOptions<{
    readonly fragment: Y.XmlFragment;
    readonly transactionOrigin: object;
  }>) => {
    const controller = createSurfaceUndoController(options.fragment, options.transactionOrigin);
    let delegate: SurfaceHistoryDelegate | undefined;
    const command =
      (direction: "undo" | "redo", fallback: Command): Command =>
      (state, dispatch, view) => {
        if (!delegate) return fallback(state, dispatch, view);
        if (!dispatch) return direction === "undo" ? delegate.canUndo() : delegate.canRedo();
        return direction === "undo" ? delegate.requestUndo() : delegate.requestRedo();
      };
    return {
      key: "yUndo",
      prosemirrorPlugins: [createSurfaceYUndoPlugin(controller)],
      dependsOn: ["yCursor", "ySync"],
      fragment: options.fragment,
      get undoManager() {
        return controller.get();
      },
      getSemanticSelection: controller.getSemanticSelection,
      restoreSemanticSelection: controller.restoreSemanticSelection,
      bindHistory(owner: SurfaceHistoryDelegate): () => void {
        if (delegate && delegate !== owner)
          throw new Error("This editor already has a history owner");
        delegate = owner;
        return () => {
          if (delegate === owner) delegate = undefined;
        };
      },
      undoCommand: command("undo", undoCommand),
      redoCommand: command("redo", redoCommand),
      destroy: controller.destroy,
    } as const;
  },
);
