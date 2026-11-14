import { describe, expect, test, vi } from "vite-plus/test";
import {
  createNfmEditorCommands,
  isNfmBodyEmpty,
  matchesNfmTurnInto,
  rootNfmBlocks,
  type NfmCommandBlock,
  type NfmCommandEditor,
  type NfmInsertCatalogEntry,
} from "./nfm-editor-commands";
import { NFM_TURN_INTO_DEFINITIONS } from "@/lib/nfm-turn-into-targets";

const paragraph = (id: string, text = ""): NfmCommandBlock => ({
  id,
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
  children: [],
});
const image = (id: string): NfmCommandBlock => ({ id, type: "image", children: [] });

const bodyDoc = (lines: readonly { readonly type: string; readonly size: number }[]) => {
  const node = (name: string, children: readonly unknown[], size = 0) => ({
    type: { name },
    childCount: children.length,
    firstChild: children[0] ?? null,
    content: { size },
  });
  return node("doc", [
    node(
      "blockGroup",
      lines.map((line) => node("blockContainer", [node(line.type, [], line.size)])),
    ),
  ]) as unknown as NfmCommandEditor["prosemirrorState"]["doc"];
};

function fakeEditor(initial: readonly NfmCommandBlock[], caretBlockId = initial[0]?.id ?? "") {
  let nextId = 0;
  const state = {
    document: [...initial],
    caretBlockId,
    caretPlacement: null as string | null,
    openedMenus: [] as string[],
    focusCalls: 0,
  };
  const idOf = (target: string | NfmCommandBlock) =>
    typeof target === "string" ? target : target.id;
  const editor: NfmCommandEditor = {
    get document() {
      return state.document;
    },
    isEditable: true,
    get prosemirrorState() {
      return {
        doc: bodyDoc(
          state.document.map((block) => ({
            type: block.type,
            size: Array.isArray(block.content) ? block.content.length : 1,
          })),
        ),
      };
    },
    focus: () => {
      state.focusCalls += 1;
    },
    getTextCursorPosition: () => ({
      block: state.document.find((block) => block.id === state.caretBlockId) ?? state.document[0]!,
    }),
    setTextCursorPosition: (target, placement) => {
      state.caretBlockId = idOf(target);
      state.caretPlacement = placement ?? null;
    },
    getSelection: () => undefined,
    insertBlocks: (blocks, reference, placement) => {
      const inserted = blocks.map((block) => ({
        ...(block as NfmCommandBlock),
        id: `new-${(nextId += 1)}`,
        content: [],
      }));
      const index = state.document.findIndex((block) => block.id === idOf(reference));
      state.document.splice(placement === "after" ? index + 1 : index, 0, ...inserted);
      return inserted;
    },
    replaceBlocks: (remove, insert) => {
      const removed = new Set(remove.map(idOf));
      const assign = (block: unknown): NfmCommandBlock => {
        const partial = block as NfmCommandBlock;
        return {
          ...partial,
          id: `new-${(nextId += 1)}`,
          children: (partial.children ?? []).map(assign),
        };
      };
      const insertedBlocks = insert.map(assign);
      state.document = [
        ...state.document.filter((block) => !removed.has(block.id)),
        ...insertedBlocks,
      ];
      return { insertedBlocks };
    },
    transact: (callback) => callback(),
    getExtension: () => ({
      openSuggestionMenu: (trigger) => {
        state.openedMenus.push(trigger);
      },
    }),
    onChange: () => () => undefined,
  };
  return { editor, state };
}

const commandsFor = (
  editor: NfmCommandEditor,
  options: {
    readonly placed?: boolean;
    readonly catalog?: readonly NfmInsertCatalogEntry[];
    readonly turnBlocksInto?: Parameters<typeof createNfmEditorCommands>[1]["turnBlocksInto"];
  } = {},
) =>
  createNfmEditorCommands(editor, {
    hasPlacedCaret: () => options.placed ?? false,
    turnBlocksInto: options.turnBlocksInto ?? (() => true),
    readInsertCatalog: () => options.catalog ?? [],
  });

const catalogEntry = (key: string, run: () => void): NfmInsertCatalogEntry => ({
  key,
  title: key,
  description: null,
  group: "Blocks",
  icon: null,
  hint: null,
  run,
});

describe("NFM editor commands", () => {
  test("an insertion before any caret was placed lands at the end of the body", () => {
    const { editor, state } = fakeEditor([paragraph("a", "first"), paragraph("b", "last")]);
    const run = vi.fn();

    expect(commandsFor(editor, { catalog: [catalogEntry("table", run)] }).insert("table")).toBe(
      true,
    );

    expect(state.caretBlockId).toBe("b");
    expect(state.caretPlacement).toBe("end");
    expect(run).toHaveBeenCalledOnce();
  });

  test("an insertion follows the caret the person placed, without moving it", () => {
    const { editor, state } = fakeEditor([paragraph("a", "first"), paragraph("b", "last")], "a");
    const run = vi.fn();

    commandsFor(editor, { placed: true, catalog: [catalogEntry("emoji", run)] }).insert("emoji");

    expect(state.caretBlockId).toBe("a");
    expect(state.caretPlacement).toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });

  test("an insertion after a Block without text opens a line below it first", () => {
    const { editor, state } = fakeEditor([paragraph("a", "first"), image("img")], "img");

    commandsFor(editor, { placed: true, catalog: [catalogEntry("table", () => undefined)] }).insert(
      "table",
    );

    expect(state.document.map((block) => block.id)).toEqual(["a", "img", "new-1"]);
    expect(state.caretBlockId).toBe("new-1");
  });

  test("an unknown or read-only insertion does nothing", () => {
    const { editor } = fakeEditor([paragraph("a")]);
    const run = vi.fn();
    const catalog = [catalogEntry("table", run)];

    expect(commandsFor(editor, { catalog }).insert("missing")).toBe(false);
    expect(commandsFor({ ...editor, isEditable: false }, { catalog }).insert("table")).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  test("the insert menu reuses an empty line and opens one below text", () => {
    const empty = fakeEditor([paragraph("a")]);
    commandsFor(empty.editor, { placed: true }).openInsertMenu();
    expect(empty.state.document).toHaveLength(1);
    expect(empty.state.openedMenus).toEqual(["/"]);

    const written = fakeEditor([paragraph("a", "text")]);
    commandsFor(written.editor, { placed: true }).openInsertMenu();
    expect(written.state.document.map((block) => block.id)).toEqual(["a", "new-1"]);
    expect(written.state.caretBlockId).toBe("new-1");
  });

  test("turning into a style passes the selection's roots and every selected Block", () => {
    const child = paragraph("child", "nested");
    const parent: NfmCommandBlock = { ...paragraph("parent", "outer"), children: [child] };
    const { editor } = fakeEditor([parent]);
    const turnBlocksInto = vi.fn(() => true);
    const selecting = { ...editor, getSelection: () => ({ blocks: [parent, child] }) };

    commandsFor(selecting, { turnBlocksInto }).turnInto("heading-2");

    expect(turnBlocksInto).toHaveBeenCalledWith(
      expect.objectContaining({
        rootBlockIds: ["parent"],
        expandedBlockIds: ["parent", "child"],
        target: { kind: "heading", level: "two", toggleable: false },
      }),
    );
  });

  test("the style at the caret tells a heading's level and a toggle heading apart", () => {
    const definition = (key: string) =>
      NFM_TURN_INTO_DEFINITIONS.find((candidate) => candidate.key === key)!;
    const heading = { type: "heading", props: { level: 2, isToggleable: false } };

    expect(matchesNfmTurnInto(heading, definition("heading-2"))).toBe(true);
    expect(matchesNfmTurnInto(heading, definition("heading-3"))).toBe(false);
    expect(matchesNfmTurnInto(heading, definition("toggle-heading-2"))).toBe(false);
    expect(rootNfmBlocks([paragraph("a"), paragraph("b")]).map((block) => block.id)).toEqual([
      "a",
      "b",
    ]);
  });

  test("only a body of one empty line counts as empty", () => {
    expect(isNfmBodyEmpty(fakeEditor([paragraph("a")]).editor)).toBe(true);
    expect(isNfmBodyEmpty(fakeEditor([paragraph("a", "text")]).editor)).toBe(false);
    expect(isNfmBodyEmpty(fakeEditor([paragraph("a"), paragraph("b")]).editor)).toBe(false);
    expect(isNfmBodyEmpty(fakeEditor([image("img")]).editor)).toBe(false);
  });

  test("a template fills only an empty body and leaves the caret where writing begins", () => {
    const template = [
      { type: "heading", props: { level: 2 }, content: "Goal" },
      { type: "paragraph", caret: true as const },
      { type: "heading", props: { level: 2 }, content: "Context" },
    ];
    const empty = fakeEditor([paragraph("a")]);

    expect(commandsFor(empty.editor).fillEmptyBody(template)).toBe(true);
    expect(empty.state.document.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "heading",
    ]);
    expect(empty.state.caretBlockId).toBe(empty.state.document[1]?.id);
    expect(empty.state.document[1]).not.toHaveProperty("caret");

    const written = fakeEditor([paragraph("a", "kept")]);
    expect(commandsFor(written.editor).fillEmptyBody(template)).toBe(false);
    expect(written.state.document).toHaveLength(1);
  });
});
