import { callOrReturn, Extension, getExtensionField } from "@tiptap/core";
import { Plugin, TextSelection } from "prosemirror-state";
import {
  columnResizing,
  columnResizingPluginKey,
  goToNextCell,
  isInTable,
  moveCellForward,
  nextCell,
  selectionCell,
  tableEditing,
  TableMap,
} from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";

const RESIZE_HANDLE_WIDTH = 5;
export const RESIZE_MIN_WIDTH = 35;
export const AUTO_CELL_MIN_WIDTH = 0;
export const EMPTY_CELL_WIDTH = 120;
export const EMPTY_CELL_HEIGHT = 31;

function resetColumnWidth(view: EditorView, event: MouseEvent): boolean {
  const resize = columnResizingPluginKey.getState(view.state);
  if (
    !view.editable ||
    !resize ||
    resize.dragging ||
    resize.activeHandle < 0
  ) {
    return false;
  }

  const edgeCell = view.nodeDOM(resize.activeHandle);
  if (!(edgeCell instanceof Element) || !(event.target instanceof Element)) {
    return false;
  }

  const targetCell = event.target.closest("td, th");
  if (
    !targetCell ||
    targetCell.closest("table") !== edgeCell.closest("table") ||
    Math.abs(edgeCell.getBoundingClientRect().right - event.clientX) >
      RESIZE_HANDLE_WIDTH
  ) {
    return false;
  }

  const $cell = view.state.doc.resolve(resize.activeHandle);
  const table = $cell.node(-1);
  const start = $cell.start(-1);
  const map = TableMap.get(table);
  const column = map.findCell($cell.pos - start).right - 1;
  const tr = view.state.tr;

  for (let row = 0; row < map.height; row++) {
    const slot = row * map.width + column;
    const pos = map.map[slot];
    if (row > 0 && pos === map.map[slot - map.width]) {
      continue;
    }

    const cell = table.nodeAt(pos);
    const widths: number[] | null | undefined = cell?.attrs.colwidth;
    if (!cell || !widths) {
      continue;
    }

    const index = cell.attrs.colspan === 1 ? 0 : column - map.colCount(pos);
    if (!widths[index]) {
      continue;
    }

    const colwidth = widths.slice();
    colwidth[index] = 0;
    tr.setNodeMarkup(start + pos, null, {
      ...cell.attrs,
      colwidth: colwidth.some(Boolean) ? colwidth : null,
    });
  }

  if (tr.docChanged) {
    view.dispatch(tr);
  }
  event.preventDefault();
  return true;
}

export const TableExtension = Extension.create({
  name: "BlockNoteTableExtension",

  addProseMirrorPlugins: () => {
    return [
      columnResizing({
        cellMinWidth: RESIZE_MIN_WIDTH,
        handleWidth: RESIZE_HANDLE_WIDTH,
        defaultCellMinWidth: AUTO_CELL_MIN_WIDTH,
        pinColumns: true,
        // We set this to null as we implement our own node view in the table
        // block content. This node view is the same as what's used by default,
        // but is wrapped in a `blockContent` HTML element.
        View: null,
      }),
      new Plugin({
        props: {
          handleDOMEvents: {
            dblclick: resetColumnWidth,
          },
        },
      }),
      tableEditing(),
    ];
  },

  addKeyboardShortcuts() {
    return {
      // Moves the selection to the cell below.
      Enter: () => {
        if (!isInTable(this.editor.state)) {
          return false;
        }

        return this.editor.commands.command(({ state, dispatch }) => {
          const $cell = selectionCell(state);
          const $nextCell = $cell ? nextCell($cell, "vert", 1) : null;

          if ($nextCell && dispatch) {
            dispatch(
              state.tr
                .setSelection(
                  TextSelection.between($nextCell, moveCellForward($nextCell)),
                )
                .scrollIntoView(),
            );
          }

          return true;
        });
      },
      // Ensures that backspace won't delete the table if the text cursor is at
      // the start of a cell and the selection is empty.
      Backspace: () => {
        const selection = this.editor.state.selection;
        const selectionIsEmpty = selection.empty;
        const selectionIsAtStartOfNode = selection.$head.parentOffset === 0;
        const selectionIsInTableParagraphNode =
          selection.$head.node().type.name === "tableParagraph";

        return (
          selectionIsEmpty &&
          selectionIsAtStartOfNode &&
          selectionIsInTableParagraphNode
        );
      },
      // Enables navigating cells using the tab key.
      Tab: () => {
        return this.editor.commands.command(({ state, dispatch, view }) => {
          if (!isInTable(state)) {
            return false;
          }

          goToNextCell(1)(state, dispatch, view);

          // Always return true to avoid accidental indents.
          return true;
        });
      },
      "Shift-Tab": () => {
        return this.editor.commands.command(({ state, dispatch, view }) => {
          if (!isInTable(state)) {
            return false;
          }

          // Always return true to avoid accidental un-indents.
          goToNextCell(-1)(state, dispatch, view);

          return true;
        });
      },
    };
  },

  extendNodeSchema(extension) {
    const context = {
      name: extension.name,
      options: extension.options,
      storage: extension.storage,
    };

    return {
      tableRole: callOrReturn(
        getExtensionField(extension, "tableRole", context),
      ),
    };
  },
});
