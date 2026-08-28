import { DOMSerializer, Fragment, Node } from "prosemirror-model";

import { PartialBlock } from "../../../../blocks/defaultBlocks.js";
import type { BlockNoteEditor } from "../../../../editor/BlockNoteEditor.js";
import {
  BlockSchema,
  InlineContentSchema,
  StyleSchema,
} from "../../../../schema/index.js";
import { addInlineContentAttributes } from "../../../../schema/inlineContent/internal.js";
import { UnreachableCaseError } from "../../../../util/typescript.js";
import {
  inlineContentToNodes,
  tableContentToNodes,
} from "../../../nodeConversions/blockToNode.js";

import { nodeToCustomInlineContent } from "../../../nodeConversions/nodeToBlock.js";

type InternalHTMLSerializationOptions = {
  document?: Document;
  /**
   * Emits schema-owned inline wrappers instead of rendered NodeView UI. The
   * canonical form remains valid phrasing content when browsers normalize
   * clipboard HTML.
   */
  canonicalInlineContent?: boolean;
};

function serializeCanonicalInlineContent<
  I extends InlineContentSchema,
  S extends StyleSchema,
>(
  editor: BlockNoteEditor<any, I, S>,
  node: Node,
  serializer: DOMSerializer,
  options: InternalHTMLSerializationOptions,
): HTMLElement {
  const doc = options.document ?? document;
  const spec = editor.schema.inlineContentSpecs[node.type.name];
  const inlineContent = nodeToCustomInlineContent(
    node,
    editor.schema.inlineContentSchema,
    editor.schema.styleSchema,
  );
  const dom = doc.createElement("span");
  dom.className = "bn-inline-content-section";

  const contentDOM = spec.config.content === "none" ? undefined : doc.createElement("span");
  if (contentDOM) {
    dom.appendChild(contentDOM);
    contentDOM.appendChild(serializeNodesInternalHTML(editor, node.content, serializer, options));
  }

  return addInlineContentAttributes(
    { dom, contentDOM },
    node.type.name,
    inlineContent.props,
    spec.config.propSchema,
  ).dom;
}

function serializeNodesInternalHTML<I extends InlineContentSchema, S extends StyleSchema>(
  editor: BlockNoteEditor<any, I, S>,
  nodes: Fragment,
  serializer: DOMSerializer,
  options: InternalHTMLSerializationOptions,
): DocumentFragment {
  const doc = options.document ?? document;
  const fragment = doc.createDocumentFragment();

  nodes.forEach((node) => {
    if (
      options.canonicalInlineContent &&
      node.type.name !== "text" &&
      editor.schema.inlineContentSchema[node.type.name]
    ) {
      fragment.appendChild(serializeCanonicalInlineContent(editor, node, serializer, options));
      return;
    }

    if (node.type.name !== "text" && editor.schema.inlineContentSchema[node.type.name]) {
      const inlineContentImplementation =
        editor.schema.inlineContentSpecs[node.type.name].implementation;

      if (inlineContentImplementation) {
        const inlineContent = nodeToCustomInlineContent(
          node,
          editor.schema.inlineContentSchema,
          editor.schema.styleSchema,
        );
        const output = inlineContentImplementation.render.call(
          {
            renderType: "dom",
            props: undefined,
          },
          inlineContent as any,
          () => {
            // No-op
          },
          editor as any,
        );

        if (output) {
          fragment.appendChild(output.dom);
          if (output.contentDOM) {
            output.contentDOM.dataset.editable = "";
            output.contentDOM.appendChild(
              serializeNodesInternalHTML(editor, node.content, serializer, options),
            );
          }
          return;
        }
      }
    } else if (node.type.name === "text") {
      // Text is serialized manually because style implementations, rather than
      // ProseMirror's mark DOM, own BlockNote's HTML representation.
      let dom: globalThis.Node | Text = doc.createTextNode(node.textContent);
      for (const mark of node.marks.toReversed()) {
        if (mark.type.name in editor.schema.styleSpecs) {
          const newDom = editor.schema.styleSpecs[mark.type.name].implementation.render(
            mark.attrs["stringValue"],
            editor,
          );
          newDom.contentDOM!.appendChild(dom);
          dom = newDom.dom;
        } else {
          const domOutputSpec = mark.type.spec.toDOM!(mark, true);
          const newDom = DOMSerializer.renderSpec(doc, domOutputSpec);
          newDom.contentDOM!.appendChild(dom);
          dom = newDom.dom;
        }
      }
      fragment.appendChild(dom);
      return;
    } else {
      fragment.appendChild(
        serializer.serializeFragment(Fragment.from([node]), {
          document: doc,
        }),
      );
    }
  });

  return fragment;
}

export function serializeInlineContentInternalHTML<
  BSchema extends BlockSchema,
  I extends InlineContentSchema,
  S extends StyleSchema,
>(
  editor: BlockNoteEditor<any, I, S>,
  blockContent: PartialBlock<BSchema, I, S>["content"],
  serializer: DOMSerializer,
  blockType?: string,
  options: InternalHTMLSerializationOptions = {},
) {
  let nodes: Node[];

  // TODO: reuse function from nodeconversions?
  if (!blockContent) {
    throw new Error("blockContent is required");
  } else if (typeof blockContent === "string") {
    nodes = inlineContentToNodes([blockContent], editor.pmSchema, blockType);
  } else if (Array.isArray(blockContent)) {
    nodes = inlineContentToNodes(blockContent, editor.pmSchema, blockType);
  } else if (blockContent.type === "tableContent") {
    nodes = tableContentToNodes(blockContent, editor.pmSchema);
  } else {
    throw new UnreachableCaseError(blockContent.type);
  }

  return serializeNodesInternalHTML(editor, Fragment.from(nodes), serializer, options);
}

function serializeBlock<
  BSchema extends BlockSchema,
  I extends InlineContentSchema,
  S extends StyleSchema,
>(
  editor: BlockNoteEditor<BSchema, I, S>,
  block: PartialBlock<BSchema, I, S>,
  serializer: DOMSerializer,
  options?: InternalHTMLSerializationOptions,
) {
  const BC_NODE = editor.pmSchema.nodes["blockContainer"];

  // set default props in case we were passed a partial block
  const props = block.props || {};
  for (const [name, spec] of Object.entries(
    editor.schema.blockSchema[block.type as any].propSchema,
  )) {
    if (!(name in props) && spec.default !== undefined) {
      (props as any)[name] = spec.default;
    }
  }
  const children = block.children || [];

  const impl = editor.blockImplementations[block.type as any].implementation;
  const ret = impl.render.call(
    {
      renderType: "dom",
      props: undefined,
    },
    { ...block, props, children } as any,
    editor as any,
  );

  if (ret.contentDOM && block.content) {
    const ic = serializeInlineContentInternalHTML(
      editor,
      block.content as any, // TODO
      serializer,
      block.type,
      options,
    );
    ret.contentDOM.appendChild(ic);
  }

  const pmType = editor.pmSchema.nodes[block.type as any];

  if (pmType.isInGroup("bnBlock")) {
    if (block.children && block.children.length > 0) {
      const fragment = serializeBlocks(
        editor,
        block.children,
        serializer,
        options,
      );

      ret.contentDOM?.append(fragment);
    }
    return ret.dom;
  }

  // wrap the block in a blockContainer
  const bc = BC_NODE.spec?.toDOM?.(
    BC_NODE.create({
      id: block.id,
      ...props,
    }),
  ) as {
    dom: HTMLElement;
    contentDOM?: HTMLElement;
  };

  bc.contentDOM?.appendChild(ret.dom);

  if (block.children && block.children.length > 0) {
    bc.contentDOM?.appendChild(
      serializeBlocksInternalHTML(editor, block.children, serializer, options),
    );
  }
  return bc.dom;
}

function serializeBlocks<
  BSchema extends BlockSchema,
  I extends InlineContentSchema,
  S extends StyleSchema,
>(
  editor: BlockNoteEditor<BSchema, I, S>,
  blocks: PartialBlock<BSchema, I, S>[],
  serializer: DOMSerializer,
  options?: InternalHTMLSerializationOptions,
) {
  const doc = options?.document ?? document;
  const fragment = doc.createDocumentFragment();

  for (const block of blocks) {
    const blockDOM = serializeBlock(editor, block, serializer, options);
    fragment.appendChild(blockDOM);
  }

  return fragment;
}

export const serializeBlocksInternalHTML = <
  BSchema extends BlockSchema,
  I extends InlineContentSchema,
  S extends StyleSchema,
>(
  editor: BlockNoteEditor<BSchema, I, S>,
  blocks: PartialBlock<BSchema, I, S>[],
  serializer: DOMSerializer,
  options?: InternalHTMLSerializationOptions,
) => {
  const BG_NODE = editor.pmSchema.nodes["blockGroup"];

  const bg = BG_NODE.spec!.toDOM!(BG_NODE.create({})) as {
    dom: HTMLElement;
    contentDOM?: HTMLElement;
  };

  const fragment = serializeBlocks(editor, blocks, serializer, options);

  bg.contentDOM?.appendChild(fragment);

  return bg.dom;
};
