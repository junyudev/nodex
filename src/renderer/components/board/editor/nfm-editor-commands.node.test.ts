import { MultipleNodeSelection } from "@blocknote/core/extensions";
import { Schema, type Node } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, test, vi } from "vite-plus/test";
import { getNfmBlockSelectionIds } from "./nfm-block-selection";
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
import { collectSelectedBlockDecorationRanges } from "./selected-block-decorations";

describe("nfm block selection", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "blockGroup" },
      blockGroup: { content: "blockContainer*" },
      blockContainer: {
        attrs: { id: {} },
        content: "blockContent",
        group: "bnBlock",
      },
      paragraph: {
        content: "inline*",
        group: "blockContent",
      },
      atomicBlock: {
        atom: true,
        group: "blockContent",
      },
      inlineAtom: {
        atom: true,
        inline: true,
        group: "inline",
      },
      text: { group: "inline" },
    },
    marks: {},
  });

  function block(id: string, content: Node): Node {
    return schema.node("blockContainer", { id }, content);
  }

  function fixtureDoc(): Node {
    return schema.node("doc", null, [
      schema.node("blockGroup", null, [
        block("before", schema.node("paragraph", null, schema.text("before"))),
        block("atomic", schema.node("atomicBlock")),
        block(
          "inline",
          schema.node("paragraph", null, [
            schema.text("a"),
            schema.node("inlineAtom"),
            schema.text("b"),
          ]),
        ),
      ]),
    ]);
  }

  function nodePosition(
    doc: Node,
    predicate: (node: Node) => boolean,
  ): { node: Node; pos: number } {
    let match: { node: Node; pos: number } | undefined;
    doc.descendants((node, pos) => {
      if (!predicate(node)) return true;
      match = { node, pos };
      return false;
    });
    if (!match) throw new Error("Missing fixture node");
    return match;
  }

  describe("NFM Block selection identity", () => {
    test("resolves an outer Block node selection directly", () => {
      const doc = fixtureDoc();
      const atomic = nodePosition(doc, (node) => node.attrs.id === "atomic");

      expect(getNfmBlockSelectionIds(NodeSelection.create(doc, atomic.pos))).toEqual(["atomic"]);
    });

    test("maps a selected atomic Block content node to its owning Block", () => {
      const doc = fixtureDoc();
      const atomic = nodePosition(doc, (node) => node.attrs.id === "atomic");

      expect(getNfmBlockSelectionIds(NodeSelection.create(doc, atomic.pos + 1))).toEqual([
        "atomic",
      ]);
    });

    test("preserves every outer Block in a multiple selection", () => {
      const doc = fixtureDoc();
      const before = nodePosition(doc, (node) => node.attrs.id === "before");
      const atomic = nodePosition(doc, (node) => node.attrs.id === "atomic");
      const selection = MultipleNodeSelection.create(
        doc,
        before.pos,
        atomic.pos + atomic.node.nodeSize,
      );

      expect(getNfmBlockSelectionIds(selection)).toEqual(["before", "atomic"]);
    });

    test("does not promote an inline atom to its owning Block", () => {
      const doc = fixtureDoc();
      const inlineAtom = nodePosition(doc, (node) => node.type.name === "inlineAtom");

      expect(getNfmBlockSelectionIds(NodeSelection.create(doc, inlineAtom.pos))).toEqual([]);
    });
  });
});

describe("nfm editor commands", () => {
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
        block:
          state.document.find((block) => block.id === state.caretBlockId) ?? state.document[0]!,
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

      commandsFor(editor, {
        placed: true,
        catalog: [catalogEntry("table", () => undefined)],
      }).insert("table");

      expect(state.document.map((block) => block.id)).toEqual(["a", "img", "new-1"]);
      expect(state.caretBlockId).toBe("new-1");
    });

    test("an unknown or read-only insertion does nothing", () => {
      const { editor } = fakeEditor([paragraph("a")]);
      const run = vi.fn();
      const catalog = [catalogEntry("table", run)];

      expect(commandsFor(editor, { catalog }).insert("missing")).toBe(false);
      expect(commandsFor({ ...editor, isEditable: false }, { catalog }).insert("table")).toBe(
        false,
      );
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
});

describe("selected block decorations", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "blockGroup" },
      blockGroup: { content: "blockContainer*" },
      blockContainer: {
        attrs: { id: {} },
        content: "blockContent blockGroup?",
      },
      paragraph: {
        content: "text*",
        group: "blockContent",
      },
      atom: {
        atom: true,
        group: "blockContent",
      },
      text: { group: "inline" },
    },
    marks: {},
  });

  function paragraph(id: string, text: string) {
    return schema.node("blockContainer", { id }, [
      schema.node("paragraph", null, text ? schema.text(text) : undefined),
    ]);
  }

  function atom(id: string) {
    return schema.node("blockContainer", { id }, [schema.node("atom")]);
  }

  function fixtureDoc() {
    return schema.node("doc", null, [
      schema.node("blockGroup", null, [
        paragraph("before", "123456789"),
        atom("atomic"),
        paragraph("after", "after"),
      ]),
    ]);
  }

  function blockPosition(doc: Node, id: string) {
    let match: { node: Node; pos: number } | undefined;
    doc.descendants((node, pos) => {
      if (node.type.name !== "blockContainer" || node.attrs.id !== id) return true;
      match = { node, pos };
      return false;
    });
    if (!match) throw new Error(`Missing fixture Block ${id}`);
    return match;
  }

  function inlinePosition(doc: Node, blockId: string, offset: number) {
    const block = blockPosition(doc, blockId);
    return block.pos + 2 + offset;
  }

  describe("selected Block decorations", () => {
    test("decorates an atomic content NodeSelection through its stable Block container", () => {
      const doc = fixtureDoc();
      const atomic = blockPosition(doc, "atomic");
      const selection = NodeSelection.create(doc, atomic.pos + 1);

      expect(collectSelectedBlockDecorationRanges(doc, selection)).toEqual([
        {
          from: atomic.pos,
          to: atomic.pos + atomic.node.nodeSize,
          kind: "structural",
        },
      ]);
    });

    test("decorates every Block in a structural multiple selection", () => {
      const doc = fixtureDoc();
      const before = blockPosition(doc, "before");
      const atomic = blockPosition(doc, "atomic");
      const selection = MultipleNodeSelection.create(
        doc,
        before.pos,
        atomic.pos + atomic.node.nodeSize,
      );

      expect(collectSelectedBlockDecorationRanges(doc, selection)).toEqual([
        {
          from: before.pos,
          to: before.pos + before.node.nodeSize,
          kind: "structural",
        },
        {
          from: atomic.pos,
          to: atomic.pos + atomic.node.nodeSize,
          kind: "structural",
        },
      ]);
    });

    test("does not decorate an unrelated atomic Block after a text selection", () => {
      const doc = fixtureDoc();
      const selection = TextSelection.create(
        doc,
        inlinePosition(doc, "before", 6),
        inlinePosition(doc, "before", 7),
      );

      expect(collectSelectedBlockDecorationRanges(doc, selection)).toEqual([]);
    });

    test("projects a retained command target as complete Blocks without changing its text range", () => {
      const doc = fixtureDoc();
      const before = blockPosition(doc, "before");
      const after = blockPosition(doc, "after");
      const selection = TextSelection.create(
        doc,
        inlinePosition(doc, "before", 6),
        inlinePosition(doc, "before", 7),
      );

      expect(
        collectSelectedBlockDecorationRanges(doc, selection, new Set(["before", "after"])),
      ).toEqual([
        {
          from: before.pos,
          to: before.pos + before.node.nodeSize,
          kind: "block-action",
        },
        {
          from: after.pos,
          to: after.pos + after.node.nodeSize,
          kind: "block-action",
        },
      ]);
    });

    test("does not decorate an atomic Block when a text range ends before it", () => {
      const doc = fixtureDoc();
      const selection = TextSelection.create(
        doc,
        inlinePosition(doc, "before", 6),
        inlinePosition(doc, "before", 9),
      );

      expect(collectSelectedBlockDecorationRanges(doc, selection)).toEqual([]);
    });

    test("decorates an atomic Block only when a text range fully contains it", () => {
      const doc = fixtureDoc();
      const atomic = blockPosition(doc, "atomic");
      const selection = TextSelection.create(
        doc,
        inlinePosition(doc, "before", 6),
        inlinePosition(doc, "after", 2),
      );

      expect(collectSelectedBlockDecorationRanges(doc, selection)).toEqual([
        {
          from: atomic.pos,
          to: atomic.pos + atomic.node.nodeSize,
          kind: "atomic-range",
        },
      ]);
    });
  });
});
