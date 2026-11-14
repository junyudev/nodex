import type { ReactNode } from "react";
import { SuggestionMenu } from "@blocknote/core/extensions";
import {
  NFM_TURN_INTO_DEFINITIONS,
  type NfmTurnBlocksIntoInput,
  type NfmTurnIntoDefinition,
} from "@/lib/nfm-turn-into-targets";
import {
  findNfmTemplateCaretPath,
  toNfmPartialBlock,
  type NfmTemplateBlock,
} from "@/lib/editor-model/nfm-template-blocks";
import type { NfmTurnIntoBlockKey } from "./nfm-turn-into-block-icon";

/** One entry of the insert catalog, as an insert menu outside the editor presents it. */
export interface NfmInsertItem {
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly group: string;
  readonly icon: ReactNode;
  /** The typed shortcut that inserts the same thing, when there is one. */
  readonly hint: string | null;
}

/**
 * Authoring commands that chrome outside the editor, such as a Page's toolbar, runs on the
 * body. Insertions land at the caret once the person has placed one in this editor, and at
 * the end of the body before that, so a toolbar click never edits somewhere unseen.
 */
export interface NfmEditorCommands {
  /** Returns focus to the body, restoring its caret. */
  focus(): void;
  /** Opens the insert menu on an empty line at the caret, opening one below when needed. */
  openInsertMenu(): boolean;
  /** Everything the body can insert: the catalog its own insert menu offers. */
  listInsertItems(): readonly NfmInsertItem[];
  /** Runs one catalog entry at the caret. */
  insert(key: string): boolean;
  /** The block type at the caret, when it is one a Block can be turned into. */
  readTurnIntoKey(): NfmTurnIntoBlockKey | null;
  /** Turns the Blocks at the caret or selection into another block type. */
  turnInto(key: NfmTurnIntoBlockKey): boolean;
  /** True while the body holds nothing but one empty line. */
  isEmpty(): boolean;
  /** Replaces an empty body with template Blocks, then puts the caret where writing begins. */
  fillEmptyBody(blocks: readonly NfmTemplateBlock[]): boolean;
  /** Notifies after every change to the body, local or remote. */
  subscribe(listener: () => void): () => void;
}

export interface NfmCommandBlock {
  readonly id: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
  readonly children?: readonly NfmCommandBlock[];
}

interface ProseMirrorNodeLike {
  readonly childCount: number;
  readonly firstChild: ProseMirrorNodeLike | null;
  readonly type: { readonly name: string };
  readonly content: { readonly size: number };
}

/** The editor surface these commands use; BlockNote's editor satisfies it. */
export interface NfmCommandEditor {
  readonly document: readonly NfmCommandBlock[];
  readonly isEditable: boolean;
  readonly prosemirrorState: { readonly doc: ProseMirrorNodeLike };
  focus(): void;
  getTextCursorPosition(): { readonly block: NfmCommandBlock };
  setTextCursorPosition(target: string | NfmCommandBlock, placement?: "start" | "end"): void;
  getSelection(): { readonly blocks: readonly NfmCommandBlock[] } | undefined;
  insertBlocks(
    blocks: readonly unknown[],
    reference: string | NfmCommandBlock,
    placement: "before" | "after",
  ): readonly NfmCommandBlock[];
  replaceBlocks(
    remove: readonly (string | NfmCommandBlock)[],
    insert: readonly unknown[],
  ): { readonly insertedBlocks: readonly NfmCommandBlock[] };
  transact<T>(callback: () => T): T;
  getExtension(
    extension: typeof SuggestionMenu,
  ): { openSuggestionMenu(triggerCharacter: string): void } | undefined;
  onChange(callback: () => void): (() => void) | void;
}

/** A catalog entry with the action that inserts it at the caret. */
export interface NfmInsertCatalogEntry extends NfmInsertItem {
  readonly run: () => void;
}

const TURN_INTO_DEFINITION_BY_KEY: ReadonlyMap<string, NfmTurnIntoDefinition> = new Map(
  NFM_TURN_INTO_DEFINITIONS.map((definition) => [definition.key, definition]),
);

const hasEmptyInlineContent = (block: NfmCommandBlock): boolean =>
  Array.isArray(block.content) && block.content.length === 0;

/** The add-Block rule shared with the side menu's +: reuse an empty line, else open one below. */
export function openNfmInsertMenuAt(editor: NfmCommandEditor, block: NfmCommandBlock): boolean {
  const target = hasEmptyInlineContent(block)
    ? block
    : editor.insertBlocks([{ type: "paragraph" }], block, "after")[0];
  if (!target) return false;
  editor.setTextCursorPosition(target);
  editor.focus();
  editor.getExtension(SuggestionMenu)?.openSuggestionMenu("/");
  return true;
}

/** Whether the body is one empty paragraph, read from the ProseMirror tree in constant time. */
export function isNfmBodyEmpty(editor: Pick<NfmCommandEditor, "prosemirrorState">): boolean {
  const group = editor.prosemirrorState.doc.firstChild;
  if (!group || group.childCount !== 1) return false;
  const container = group.firstChild;
  // A container with a nested group has children, so the line is not alone.
  if (!container || container.childCount !== 1) return false;
  const line = container.firstChild;
  return line?.type.name === "paragraph" && line.content.size === 0;
}

export function matchesNfmTurnInto(
  block: Pick<NfmCommandBlock, "type" | "props">,
  definition: NfmTurnIntoDefinition,
): boolean {
  if (block.type !== definition.localPatch.type) return false;
  if (block.type !== "heading") return true;
  const props = definition.localPatch.props ?? {};
  return (
    block.props?.level === props.level &&
    Boolean(block.props?.isToggleable) === Boolean(props.isToggleable)
  );
}

/** The top-level Blocks of a selection: a selected parent already carries its children. */
export function rootNfmBlocks(blocks: readonly NfmCommandBlock[]): readonly NfmCommandBlock[] {
  const descendantIds = new Set<string>();
  const collect = (children: readonly NfmCommandBlock[] | undefined) => {
    for (const child of children ?? []) {
      descendantIds.add(child.id);
      collect(child.children);
    }
  };
  for (const block of blocks) collect(block.children);
  return blocks.filter((block) => !descendantIds.has(block.id));
}

export function createNfmEditorCommands(
  editor: NfmCommandEditor,
  {
    hasPlacedCaret,
    turnBlocksInto,
    readInsertCatalog,
  }: {
    /** Whether the person has put the caret in this editor since it opened. */
    readonly hasPlacedCaret: () => boolean;
    readonly turnBlocksInto: (input: NfmTurnBlocksIntoInput) => boolean;
    readonly readInsertCatalog: () => readonly NfmInsertCatalogEntry[];
  },
): NfmEditorCommands {
  const lastBlock = (): NfmCommandBlock | undefined => editor.document[editor.document.length - 1];

  /** The Block an insertion starts from: the caret's, or the end of the body before one. */
  const insertionAnchor = (): NfmCommandBlock | undefined =>
    hasPlacedCaret() ? editor.getTextCursorPosition().block : lastBlock();

  /** Places the caret on a line a catalog entry can fill or follow. */
  const placeInsertionCaret = (): boolean => {
    const anchor = insertionAnchor();
    if (!anchor) return false;
    if (anchor.content !== undefined) {
      if (!hasPlacedCaret()) editor.setTextCursorPosition(anchor, "end");
      return true;
    }
    // A Block without inline content (an image, a table) is followed by a new line.
    const line = editor.insertBlocks([{ type: "paragraph" }], anchor, "after")[0];
    if (!line) return false;
    editor.setTextCursorPosition(line, "end");
    return true;
  };

  return {
    focus: () => editor.focus(),
    openInsertMenu: () => {
      if (!editor.isEditable) return false;
      const anchor = insertionAnchor();
      return anchor ? openNfmInsertMenuAt(editor, anchor) : false;
    },
    listInsertItems: () => readInsertCatalog().map(({ run: _run, ...item }) => item),
    insert: (key) => {
      if (!editor.isEditable) return false;
      const entry = readInsertCatalog().find((candidate) => candidate.key === key);
      if (!entry || !placeInsertionCaret()) return false;
      // Entries that continue in a picker at the caret need the body focused first.
      editor.focus();
      entry.run();
      return true;
    },
    readTurnIntoKey: () => {
      const block = editor.getTextCursorPosition().block;
      const definition = NFM_TURN_INTO_DEFINITIONS.find((candidate) =>
        matchesNfmTurnInto(block, candidate),
      );
      return definition?.key ?? null;
    },
    turnInto: (key) => {
      const definition = TURN_INTO_DEFINITION_BY_KEY.get(key);
      if (!definition || !editor.isEditable) return false;
      const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
      if (blocks.length === 0) return false;
      const turned = turnBlocksInto({
        rootBlockIds: rootNfmBlocks(blocks).map((block) => block.id),
        expandedBlockIds: blocks.map((block) => block.id),
        target: definition.target,
        localPatch: definition.localPatch,
      });
      editor.focus();
      return turned;
    },
    isEmpty: () => isNfmBodyEmpty(editor),
    fillEmptyBody: (blocks) => {
      if (!editor.isEditable || blocks.length === 0 || !isNfmBodyEmpty(editor)) return false;
      const emptyLine = editor.document[0];
      if (!emptyLine) return false;
      const inserted = editor.transact(
        () => editor.replaceBlocks([emptyLine], blocks.map(toNfmPartialBlock)).insertedBlocks,
      );
      let caretBlock: NfmCommandBlock | undefined;
      let level: readonly NfmCommandBlock[] | undefined = inserted;
      for (const index of findNfmTemplateCaretPath(blocks)) {
        caretBlock = level?.[index];
        level = caretBlock?.children;
      }
      const target = caretBlock ?? inserted[inserted.length - 1];
      if (target) editor.setTextCursorPosition(target, "end");
      editor.focus();
      return true;
    },
    subscribe: (listener) => {
      const unsubscribe = editor.onChange(() => listener());
      return () => unsubscribe?.();
    },
  };
}
