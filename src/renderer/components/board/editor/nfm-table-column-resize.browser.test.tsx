import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { act, render } from "@testing-library/react";
import type { CDPSession } from "@vitest/browser-playwright";
import { expect, test } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

import { createPageDocumentGenesis } from "../../../../shared/block-documents/block-document-codec";
import { createNfmEditorModeOptions } from "./nfm-editor-source";

const tableMarkdown = [
  "| Short column heading | A longer column heading | The last column heading |",
  "| --- | --- | --- |",
  "| First cell text | Some more cell text | Final cell text |",
].join("\n");

async function mountTable(widths?: string) {
  const tableSource = widths
    ? `:::table{widths="${widths}"}\n${tableMarkdown}\n:::`
    : tableMarkdown;
  const { document } = createPageDocumentGenesis({
    documentId: "document:table-resize",
    markdown: `Column widths\n\n${tableSource}`,
  });
  const editor = BlockNoteEditor.create(
    createNfmEditorModeOptions({
      kind: "collaborative-document",
      documentId: document.guid,
      storeEpoch: "epoch:table-resize",
      generation: 1,
      clientSessionId: "surface:table-resize",
      fragment: document.getXmlFragment("body"),
      user: { name: "Table editing", color: "#2563eb" },
    }),
  );
  const view = render(
    <div style={{ width: 360 }}>
      <BlockNoteViewRaw
        editor={editor}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      />
    </div>,
  );
  const table = await view.findByRole("table");
  if (!(table instanceof HTMLTableElement)) throw new Error("Expected the editor table");
  const renderedWidths = () =>
    Array.from(table.rows[0].cells, (cell) => cell.getBoundingClientRect().width);
  const storedWidths = () => {
    const result: Array<number | null> = [];
    editor.prosemirrorState.doc.descendants((node) => {
      const role = node.type.spec.tableRole;
      if (role === "cell" || role === "header_cell") {
        result.push(node.attrs.colwidth?.[0] ?? null);
      }
    });
    return result;
  };
  const changes: Array<ReturnType<typeof storedWidths>> = [];
  const stopObserving = editor.onChange(() => changes.push(storedWidths()));

  return {
    editor,
    table,
    renderedWidths,
    storedWidths,
    changes,
    cleanup() {
      stopObserving();
      view.unmount();
      editor._tiptapEditor.destroy();
      document.destroy();
    },
  };
}

function columnEdge(table: HTMLTableElement, column: number) {
  const { top, height, right } = table.rows[0].cells[column].getBoundingClientRect();
  return { x: Math.floor(right) - 2, y: Math.floor(top + height / 2) };
}

async function mouse(
  type: "mousePressed" | "mouseMoved" | "mouseReleased",
  { x, y }: { x: number; y: number },
  { pressed = type === "mousePressed", clickCount = 1 } = {},
) {
  const frame = window.frameElement?.getBoundingClientRect();
  const session: CDPSession = cdp();
  await act(async () => {
    await session.send("Input.dispatchMouseEvent", {
      type,
      x: x + (frame?.left ?? 0),
      y: y + (frame?.top ?? 0),
      button: pressed || type === "mouseReleased" ? "left" : "none",
      buttons: pressed ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : clickCount,
      pointerType: "mouse",
    });
  });
}

function expectWidthsWithinOnePixel(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((width, column) => {
    expect(Math.abs(width - expected[column])).toBeLessThanOrEqual(1);
  });
}

test("resizing keeps the edge under the pointer and pins all auto columns in one undo step", async () => {
  const fixture = await mountTable();
  const { table, renderedWidths, storedWidths, changes, editor } = fixture;
  try {
    expect(storedWidths()).toEqual(Array(6).fill(null));
    expect(table.style.minWidth).toBe("0px");
    expect(table.getBoundingClientRect().width).toBeCloseTo(
      table.closest(".tableWrapper-inner")!.clientWidth,
      0,
    );
    const before = renderedWidths();
    const edge = columnEdge(table, 1);
    const end = { ...edge, x: edge.x + 40 };
    const expected = [before[0], before[1] + 40, before[2]];
    await mouse("mouseMoved", edge);
    await mouse("mousePressed", edge);
    try {
      await mouse("mouseMoved", end, { pressed: true });
      expectWidthsWithinOnePixel(renderedWidths(), expected);
      expect(Math.abs(columnEdge(table, 1).x - end.x)).toBeLessThanOrEqual(1);
      expect(changes).toEqual([]);
    } finally {
      await mouse("mouseReleased", end);
    }

    const pinned = storedWidths();
    expect(pinned.every((width) => typeof width === "number" && width > 0)).toBe(true);
    expectWidthsWithinOnePixel(pinned.map(Number), [...expected, ...expected]);
    expect(changes).toEqual([pinned]);

    await act(async () => {
      expect(editor.undo()).toBe(true);
    });
    expect(storedWidths()).toEqual(Array(6).fill(null));
    expectWidthsWithinOnePixel(renderedWidths(), before);
  } finally {
    fixture.cleanup();
  }
});

test("a stationary press on an auto column edge leaves every column auto", async () => {
  const fixture = await mountTable();
  const { table, storedWidths, changes } = fixture;
  try {
    const edge = columnEdge(table, 1);
    await mouse("mouseMoved", edge);
    await mouse("mousePressed", edge);
    await mouse("mouseReleased", edge);

    expect(storedWidths()).toEqual(Array(6).fill(null));
    expect(changes).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

test("double-clicking an edge clears only that width in every row", async () => {
  const fixture = await mountTable("90,95,100");
  const { table, storedWidths, changes } = fixture;
  try {
    expect(storedWidths()).toEqual([90, 95, 100, 90, 95, 100]);
    const edge = columnEdge(table, 1);
    await mouse("mouseMoved", edge);
    await mouse("mousePressed", edge);
    await mouse("mouseReleased", edge);
    await mouse("mousePressed", edge, { clickCount: 2 });
    await mouse("mouseReleased", edge, { clickCount: 2 });

    const mixed = [90, null, 100, 90, null, 100];
    expect(storedWidths()).toEqual(mixed);
    expect(changes).toEqual([mixed]);
    expect(table.style.minWidth).toBe("190px");
  } finally {
    fixture.cleanup();
  }
});
