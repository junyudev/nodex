/** Structural editor types shared by stable-ID Block actions. */
export interface DragSessionBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: DragSessionBlock[];
}

export interface EditorForExternalBlockDrop {
  document: DragSessionBlock[];
  prosemirrorView?: {
    state: {
      selection: object;
    };
  };
  getSelection?: () => { blocks: Array<{ id: string }> } | undefined;
  getBlock: (id: string) => DragSessionBlock | undefined;
  getParentBlock: (id: string) => DragSessionBlock | undefined;
  removeBlocks: (ids: string[]) => void;
  replaceBlocks: (toRemove: unknown[], replacements: unknown[]) => void;
  transact?: <T>(fn: () => T) => T;
}
