import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc, yDocToBlocks } from "@blocknote/core/yjs";
import { describe, expect, test } from "vite-plus/test";
import fixture from "../../../crates/nodex-markdown/tests/fixtures/cases.json";
import { acceptsBlockChildren } from "../block-documents/block-children-policy";
import {
  HEADLESS_BLOCK_DOCUMENT_BLOCK_TYPES,
  headlessBlockDocumentSchema,
} from "../block-documents/headless-blocknote-schema";
import { readMarkdown, writeMarkdown, MarkdownRefusal } from "./index";

/** The committed WebAssembly module and stored schema share the Rust language fixture. */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Case {
  readonly name: string;
  readonly markdown: string;
  readonly blocks: JsonObject[];
  readonly gfm?: boolean;
  readonly reads?: string[];
  readonly nodexReads?: string[];
}

interface BoundaryRead {
  readonly name: string;
  readonly markdown: string;
  readonly blocks: JsonObject[];
}

const cases = fixture.cases as unknown as Case[];
const boundaryReads = fixture.boundaryReads as unknown as BoundaryRead[];
const OWNING_SHELLS = new Set(["page", "database", "canvas"]);

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fixture's table with what the editor needs back: cell types, and no width for `null`. */
const tableInput = (content: JsonObject) => ({
  ...content,
  columnWidths: Array.isArray(content.columnWidths)
    ? content.columnWidths.map((width) => (typeof width === "number" ? width : undefined))
    : undefined,
  rows: (Array.isArray(content.rows) ? content.rows : []).map((row) => ({
    cells: ((row as JsonObject).cells as JsonObject[]).map((cell) => ({
      type: "tableCell",
      ...cell,
    })),
  })),
});

/** Each Block as Nodex stores it: through the Block Document schema and back out of Yjs. */
function stored(blocks: readonly unknown[]): unknown[] {
  let next = 0;
  const withIds = (items: readonly unknown[]): unknown[] =>
    items.map((item) => {
      const block = item as JsonObject;
      return {
        ...block,
        id: typeof block.id === "string" ? block.id : `block-${(next += 1)}`,
        ...(block.type === "table" && isObject(block.content)
          ? { content: tableInput(block.content) }
          : {}),
        children: withIds(Array.isArray(block.children) ? block.children : []),
      };
    });
  // No Blocks is the empty Document, which Nodex keeps as one empty paragraph.
  const editor = BlockNoteEditor.create({
    schema: headlessBlockDocumentSchema,
    ...(blocks.length > 0 ? { initialContent: withIds(blocks) as never } : {}),
  });
  return yDocToBlocks(editor, blocksToYDoc(editor, editor.document, "body"), "body");
}

const blockDefaults = (type: string): Record<string, unknown> => {
  const spec = (
    headlessBlockDocumentSchema.blockSpecs as Record<
      string,
      { config: { propSchema: Record<string, { default?: unknown }> } }
    >
  )[type];
  return Object.fromEntries(
    Object.entries(spec?.config.propSchema ?? {}).map(([key, value]) => [key, value.default]),
  );
};

const inlineDefaults = (type: string): Record<string, unknown> => {
  const spec = (
    headlessBlockDocumentSchema.inlineContentSpecs as Record<
      string,
      { config: { propSchema?: Record<string, { default?: unknown }> } | string }
    >
  )[type];
  const config = spec?.config;
  if (typeof config !== "object" || !config.propSchema) return {};
  return Object.fromEntries(
    Object.entries(config.propSchema).map(([key, value]) => [key, value.default]),
  );
};

const TABLE_CELL_DEFAULTS = {
  backgroundColor: "default",
  textColor: "default",
  textAlignment: "left",
  colspan: 1,
  rowspan: 1,
};

function withoutDefaults(
  props: unknown,
  defaults: Record<string, unknown>,
): JsonObject | undefined {
  if (!isObject(props)) return undefined;
  const kept = Object.entries(props).filter(
    ([key, value]) => value !== undefined && value !== defaults[key],
  );
  return kept.length > 0 ? (Object.fromEntries(kept) as JsonObject) : undefined;
}

function compactInline(items: unknown): Json[] {
  if (!Array.isArray(items)) return [];
  return items.map((item): Json => {
    const node = item as JsonObject;
    const type = String(node.type);
    if (type === "text") {
      const styles = isObject(node.styles) && Object.keys(node.styles).length > 0;
      return { type, text: node.text ?? "", ...(styles ? { styles: node.styles } : {}) };
    }
    if (type === "link")
      return { type, href: node.href ?? "", content: compactInline(node.content) };
    const props = withoutDefaults(node.props, inlineDefaults(type));
    return {
      type,
      ...(props ? { props } : {}),
      ...(typeof node.content === "string" ? { content: node.content } : {}),
    };
  });
}

function compactTable(content: unknown): JsonObject {
  const table = isObject(content) ? content : {};
  const widths = Array.isArray(table.columnWidths) ? table.columnWidths : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  return {
    type: "tableContent",
    ...(widths.some((width) => typeof width === "number")
      ? { columnWidths: widths.map((width) => (typeof width === "number" ? width : null)) }
      : {}),
    ...(typeof table.headerRows === "number" ? { headerRows: table.headerRows } : {}),
    ...(typeof table.headerCols === "number" ? { headerCols: table.headerCols } : {}),
    rows: rows.map((row) => ({
      cells: (isObject(row) && Array.isArray(row.cells) ? row.cells : []).map((cell) => {
        const props = isObject(cell) ? withoutDefaults(cell.props, TABLE_CELL_DEFAULTS) : undefined;
        return {
          ...(props ? { props } : {}),
          content: compactInline(isObject(cell) ? cell.content : cell),
        };
      }),
    })),
  };
}

/**
 * The fixture's spelling of Blocks: no identities but an owning shell's, no props at their
 * defaults, no empty content or children, and a numbered item's `start` only where it starts a
 * list at a number other than one, since that is the only `start` Nodex numbers by.
 */
function compact(blocks: readonly unknown[]): JsonObject[] {
  return blocks.map((item, index): JsonObject => {
    const block = item as JsonObject;
    const type = String(block.type);
    const props = withoutDefaults(block.props, blockDefaults(type)) ?? {};
    const previous = blocks[index - 1] as JsonObject | undefined;
    if (type === "numberedListItem" && (previous?.type === type || props.start === 1)) {
      delete props.start;
    }
    const content =
      type === "table"
        ? compactTable(block.content)
        : Array.isArray(block.content) && block.content.length > 0
          ? compactInline(block.content)
          : undefined;
    const children = Array.isArray(block.children) ? compact(block.children) : [];
    return {
      ...(OWNING_SHELLS.has(type) && typeof block.id === "string" ? { id: block.id } : {}),
      type,
      ...(Object.keys(props).length > 0 ? { props } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(children.length > 0 ? { children } : {}),
    };
  });
}

function walk(blocks: readonly JsonObject[], visit: (block: JsonObject) => void): void {
  for (const block of blocks) {
    visit(block);
    walk((block.children as JsonObject[] | undefined) ?? [], visit);
  }
}

function inlineItems(block: JsonObject): JsonObject[] {
  const items: JsonObject[] = [];
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!isObject(item)) continue;
      items.push(item);
      collect(item.content);
    }
  };
  collect(block.content);
  if (isObject(block.content) && Array.isArray(block.content.rows)) {
    for (const row of block.content.rows) {
      for (const cell of (row as { cells: JsonObject[] }).cells) collect(cell.content);
    }
  }
  return items;
}

describe("Nodex Markdown round-trip fixture", () => {
  test("names every case once", () => {
    const names = [...cases, ...boundaryReads].map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("checks every spelling it lists as GitHub Flavored Markdown", () => {
    // A `reads` spelling on a case today's reader does not check would be an unchecked claim;
    // spellings only Nodex Markdown reads belong in `nodexReads`.
    expect(cases.filter((item) => item.reads && !item.gfm).map((item) => item.name)).toEqual([]);
  });

  test.each([...cases, ...boundaryReads].map((item) => [item.name, item] as const))(
    "%s: Blocks as Nodex stores them",
    (_name, item) => {
      expect(compact(stored(item.blocks))).toEqual(item.blocks);
      walk(item.blocks, (block) => {
        if (Array.isArray(block.children) && block.children.length > 0) {
          expect(
            acceptsBlockChildren({
              type: String(block.type),
              props: isObject(block.props) ? block.props : {},
            }),
          ).toBe(true);
        }
      });
    },
  );

  test.each(cases.map((item) => [item.name, item] as const))(
    "%s: exact writing and reading through WebAssembly",
    (_name, item) => {
      expect(writeMarkdown(item.blocks as never)).toBe(item.markdown);
      for (const markdown of [item.markdown, ...(item.reads ?? []), ...(item.nodexReads ?? [])]) {
        expect(compact(readMarkdown(markdown, "exact")), markdown).toEqual(item.blocks);
      }
    },
  );
  test.each(fixture.rejects)("refuses $name", (item) => {
    expect(() => readMarkdown(item.markdown, "exact")).toThrow(MarkdownRefusal);
  });
  test.each(boundaryReads)("boundary: $name", (item) => {
    expect(compact(readMarkdown(item.markdown, "boundary"))).toEqual(item.blocks);
  });

  test("says how to write every Block type Nodex keeps, every inline type and style", () => {
    const blockTypes = new Set<string>();
    const inlineTypes = new Set<string>();
    const styles = new Set<string>();
    for (const item of cases) {
      walk(item.blocks, (block) => {
        blockTypes.add(String(block.type));
        for (const inline of inlineItems(block)) {
          inlineTypes.add(String(inline.type));
          if (isObject(inline.styles))
            for (const style of Object.keys(inline.styles)) styles.add(style);
        }
      });
    }
    expect([...blockTypes].sort()).toEqual([...HEADLESS_BLOCK_DOCUMENT_BLOCK_TYPES].sort());
    expect([...inlineTypes].sort()).toEqual(
      ["text", "link", ...Object.keys(headlessBlockDocumentSchema.inlineContentSpecs)]
        .filter((type, index, all) => all.indexOf(type) === index)
        .sort(),
    );
    expect([...styles].sort()).toEqual(Object.keys(headlessBlockDocumentSchema.styleSpecs).sort());
  });
});
