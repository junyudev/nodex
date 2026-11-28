import { undoAutomaticInputRule } from "@blocknote/core";
import type { EditorState } from "@tiptap/pm/state";
import {
  blockAcceptsPlainTextMerge,
  blockUsesPreviewFirstSource,
} from "./block-content-capabilities";

interface AtomicBackspaceBlock {
  readonly id: string;
  readonly type: string;
  readonly children?: readonly AtomicBackspaceBlock[];
}

export interface AtomicBackspaceEditor {
  readonly document: readonly AtomicBackspaceBlock[];
  readonly schema: {
    readonly blockSchema: Readonly<Record<string, { readonly content?: string }>>;
  };
  /** Knows whether Backspace would restore the literal input of an automatic transform. */
  readonly prosemirrorState?: EditorState;
  readonly prosemirrorView?: {
    readonly state: {
      readonly selection: {
        readonly empty: boolean;
        readonly $from: {
          readonly parentOffset: number;
        };
      };
    };
  };
  getTextCursorPosition(): {
    readonly block: AtomicBackspaceBlock;
    readonly prevBlock?: AtomicBackspaceBlock;
  };
  getParentBlock(blockId: string): AtomicBackspaceBlock | undefined;
}

export type AtomicBlockBackspacePlan =
  | { readonly kind: "protect_boundary" }
  | {
      readonly kind: "merge";
      readonly sourceBlockId: string;
      readonly targetBlockId: string;
    };

/**
 * Plans the semantic merge behind Backspace at an atomic boundary.
 *
 * Non-paragraph Blocks deliberately fall through so BlockNote can first run
 * its normal type reset/list-exit command. Adjacent text Blocks also fall
 * through to BlockNote's mature local merge implementation.
 */
export function planBackspaceAcrossAtomicBlocks(
  editor: AtomicBackspaceEditor,
): AtomicBlockBackspacePlan | null {
  const view = editor.prosemirrorView;
  if (!view?.state.selection.empty || view.state.selection.$from.parentOffset !== 0) return null;
  // Backspace right after an automatic transform restores its literal input, even where the
  // transform left the caret beside an atomic Block, as `---` does below its new divider.
  if (editor.prosemirrorState && undoAutomaticInputRule(editor.prosemirrorState)) return null;

  const cursor = editor.getTextCursorPosition();
  if (blockUsesPreviewFirstSource(editor.schema, cursor.block.type)) {
    return { kind: "protect_boundary" };
  }
  if (cursor.block.type !== "paragraph") return null;
  if (!cursor.prevBlock || blockAcceptsPlainTextMerge(editor.schema, cursor.prevBlock.type)) {
    return null;
  }
  if (blockUsesPreviewFirstSource(editor.schema, cursor.prevBlock.type)) {
    return { kind: "protect_boundary" };
  }

  const parent = editor.getParentBlock(cursor.block.id);
  const siblings = parent?.children ?? editor.document;
  const currentIndex = siblings.findIndex((block) => block.id === cursor.block.id);
  if (currentIndex < 0) return null;

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = siblings[index];
    if (!candidate || !blockAcceptsPlainTextMerge(editor.schema, candidate.type)) continue;
    return {
      kind: "merge",
      sourceBlockId: cursor.block.id,
      targetBlockId: candidate.id,
    };
  }

  // Claim the key so the default joinBackward path cannot delete the atomic
  // boundary when there is no editable target in this sibling group.
  return { kind: "protect_boundary" };
}
