import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import type { BlockNoteEditor } from "../editor/BlockNoteEditor.js";
import { BlockNoteDOMAttributes } from "../schema/index.js";
import { mergeCSSClasses } from "../util/browser.js";
import { suggestionMarks } from "./suggestionMarks.js";

// Object containing all possible block attributes.
const BlockAttributes: Record<string, string> = {
  blockColor: "data-block-color",
  blockStyle: "data-block-style",
  id: "data-id",
  depth: "data-depth",
  depthChange: "data-depth-change",
};

/**
 * Identity is view metadata, not a persisted content attribute. Including it
 * in decoration equality also prevents ProseMirror's recreateWrapper fast path
 * from transplanting identical child NodeViews into a different Block.
 */
const collectBlockIdentityDecorations = (
  doc: PMNode,
  from = 0,
  to = doc.content.size,
) => {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== "blockContainer") return;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {}, { blockId: node.attrs.id }),
    );
  });
  return decorations;
};

const applySemanticAttributes = (
  element: HTMLElement,
  node: import("prosemirror-model").Node,
  editor: BlockNoteEditor<any, any, any>,
) => {
  const content = node.firstChild;
  if (!content) return;
  element.setAttribute("data-content-type", content.type.name);
  element.setAttribute(
    "data-children-layout",
    editor.schema.getBlockChildrenLayout(content.type.name),
  );
  element.setAttribute(
    "data-accepts-children",
    String(
      editor.schema.acceptsBlockChildren({
        type: content.type.name,
        props: content.attrs,
      }),
    ),
  );
};

const syncBlockAttributes = (
  blockOuter: HTMLElement,
  block: HTMLElement,
  node: import("prosemirror-model").Node,
  editor: BlockNoteEditor<any, any, any>,
) => {
  for (const [nodeAttr, HTMLAttr] of Object.entries(BlockAttributes)) {
    const value = node.attrs[nodeAttr];
    if (value === undefined || value === null) {
      blockOuter.removeAttribute(HTMLAttr);
      block.removeAttribute(HTMLAttr);
      continue;
    }
    blockOuter.setAttribute(HTMLAttr, String(value));
    block.setAttribute(HTMLAttr, String(value));
  }
  applySemanticAttributes(block, node, editor);
};

/**
 * The main "Block node" documents consist of
 */
export const BlockContainer = Node.create<{
  domAttributes?: BlockNoteDOMAttributes;
  editor: BlockNoteEditor<any, any, any>;
}>({
  name: "blockContainer",
  group: "blockGroupChild bnBlock",
  // A block always contains content, and optionally a blockGroup which contains nested blocks
  content: "blockContent blockGroup?",
  // Ensures content-specific keyboard handlers trigger first.
  priority: 50,
  defining: true,
  marks() {
    return suggestionMarks(this.editor);
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        state: {
          init: (_, state) =>
            DecorationSet.create(
              state.doc,
              collectBlockIdentityDecorations(state.doc),
            ),
          apply: (transaction, previous) => {
            if (!transaction.docChanged) return previous;
            const doc = transaction.doc;
            const range = transaction.changedRange();
            if (!range) {
              return DecorationSet.create(
                doc,
                collectBlockIdentityDecorations(doc),
              );
            }

            // Keep typing local: map unaffected identities, then refresh the
            // changed range and its ancestor containers (nodesBetween includes
            // those ancestors). Do not rescan the whole Page on each keystroke.
            const mapped = previous.map(transaction.mapping, doc);
            const next = collectBlockIdentityDecorations(
              doc,
              range.from,
              range.to,
            );
            const positions = new Set(next.map((decoration) => decoration.from));
            const replaced = mapped
              .find(range.from, range.to)
              .filter((decoration) => positions.has(decoration.from));
            return mapped.remove(replaced).add(doc, next);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
  parseHTML() {
    return [
      {
        tag: "div[data-node-type=" + this.name + "]",
        getAttrs: (element) => {
          if (typeof element === "string") {
            return false;
          }

          const attrs: Record<string, string> = {};
          for (const [nodeAttr, HTMLAttr] of Object.entries(BlockAttributes)) {
            if (element.getAttribute(HTMLAttr)) {
              attrs[nodeAttr] = element.getAttribute(HTMLAttr)!;
            }
          }

          return attrs;
        },
      },
      // Ignore `blockOuter` divs, but parse the `blockContainer` divs inside them.
      {
        tag: `div[data-node-type="blockOuter"]`,
        skip: true,
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const blockOuter = document.createElement("div");
    blockOuter.className = "bn-block-outer";
    blockOuter.setAttribute("data-node-type", "blockOuter");
    for (const [attribute, value] of Object.entries(HTMLAttributes)) {
      if (attribute !== "class") {
        blockOuter.setAttribute(attribute, value);
      }
    }

    const blockHTMLAttributes = {
      ...(this.options.domAttributes?.block || {}),
      ...HTMLAttributes,
    };
    const block = document.createElement("div");
    block.className = mergeCSSClasses("bn-block", blockHTMLAttributes.class);
    block.setAttribute("data-node-type", this.name);
    for (const [attribute, value] of Object.entries(blockHTMLAttributes)) {
      if (attribute !== "class") {
        block.setAttribute(attribute, value);
      }
    }

    blockOuter.appendChild(block);
    applySemanticAttributes(block, node, this.options.editor);

    return {
      dom: blockOuter,
      contentDOM: block,
    };
  },

  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const blockOuter = document.createElement("div");
      blockOuter.className = "bn-block-outer";
      blockOuter.setAttribute("data-node-type", "blockOuter");
      for (const [attribute, value] of Object.entries(HTMLAttributes)) {
        if (attribute !== "class") blockOuter.setAttribute(attribute, value);
      }

      const blockHTMLAttributes = {
        ...(this.options.domAttributes?.block || {}),
        ...HTMLAttributes,
      };
      const block = document.createElement("div");
      block.className = mergeCSSClasses("bn-block", blockHTMLAttributes.class);
      block.setAttribute("data-node-type", this.name);
      for (const [attribute, value] of Object.entries(blockHTMLAttributes)) {
        if (attribute !== "class") block.setAttribute(attribute, value);
      }
      blockOuter.appendChild(block);
      syncBlockAttributes(blockOuter, block, node, this.options.editor);

      return {
        dom: blockOuter,
        contentDOM: block,
        update: (nextNode) => {
          // Child NodeViews bind controls and subscriptions to this Block ID.
          // Reusing the container for a different Block would retain those
          // bindings while ProseMirror updates only the visible inline content.
          if (nextNode.type !== node.type || nextNode.attrs.id !== node.attrs.id) {
            return false;
          }
          node = nextNode;
          syncBlockAttributes(blockOuter, block, nextNode, this.options.editor);
          return true;
        },
      };
    };
  },
});
