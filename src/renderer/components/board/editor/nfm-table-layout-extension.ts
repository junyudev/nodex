import { createExtension } from "@blocknote/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { AttrStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { classifyNfmTable } from "@/lib/nfm-table-layout";

const pluginKey = new PluginKey<DecorationSet>("nfm-table-layout");

function decorateTable(table: Node, position: number): Decoration[] {
  const columnWidths: (number | undefined)[] = [];
  table.firstChild?.forEach((cell) => {
    columnWidths.push(cell.attrs.colwidth?.[0]);
  });

  const rows: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      cells.push(
        cell.textBetween(0, cell.content.size, "\n", (leaf) =>
          leaf.type.name === "hardBreak" ? "\n" : (leaf.type.spec.leafText?.(leaf) ?? ""),
        ),
      );
    });
    rows.push(cells);
  });

  const { layout, cellFits } = classifyNfmTable(rows, columnWidths);
  const decorations = [
    Decoration.node(position, position + table.nodeSize, { "data-nfm-table-layout": layout }),
  ];
  table.forEach((row, rowOffset, rowIndex) => {
    row.forEach((cell, cellOffset, columnIndex) => {
      const fit = cellFits[rowIndex][columnIndex];
      if (!fit) return;

      const from = position + 2 + rowOffset + cellOffset;
      decorations.push(Decoration.node(from, from + cell.nodeSize, { "data-nfm-cell-fit": fit }));
    });
  });
  return decorations;
}

function collectTables(doc: Node, from: number, to: number, tables: Map<number, Node>): void {
  doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== "table") return;
    tables.set(position, node);
    return false;
  });
}

function updateDecorations(transaction: Transaction, previous: DecorationSet): DecorationSet {
  if (!transaction.docChanged) return previous;

  const { doc, mapping, steps } = transaction;
  const tables = new Map<number, Node>();
  for (const [index, step] of steps.entries()) {
    const remaining = mapping.slice(index + 1);
    const collect = (from: number, to: number) =>
      collectTables(doc, remaining.map(from, -1), remaining.map(to, 1), tables);

    // Cell-width changes can preserve every position, so their StepMap is empty.
    if (step instanceof AttrStep && step.attr === "colwidth") collect(step.pos, step.pos + 1);
    mapping.maps[index].forEach((_oldFrom, _oldTo, from, to) => collect(from, to));
  }

  let decorations = previous.map(mapping, doc);
  for (const [position, table] of tables) {
    const stale = decorations.find(position + 1, position + table.nodeSize - 1);
    decorations = decorations.remove(stale).add(doc, decorateTable(table, position));
  }
  return decorations;
}

export const nfmTableLayoutExtension = createExtension({
  key: "nfm-table-layout",
  prosemirrorPlugins: [
    new Plugin({
      key: pluginKey,
      state: {
        init: (_config, { doc }) => {
          const tables = new Map<number, Node>();
          collectTables(doc, 0, doc.content.size, tables);
          return DecorationSet.create(
            doc,
            Array.from(tables, ([position, table]) => decorateTable(table, position)).flat(),
          );
        },
        apply: updateDecorations,
      },
      props: {
        decorations: (state) => pluginKey.getState(state),
      },
    }),
  ],
});
