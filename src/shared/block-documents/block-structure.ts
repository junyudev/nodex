import * as Y from "yjs";
import { MAX_BLOCK_ID_LENGTH, MAX_PAGE_DOCUMENT_XML_PATH_DEPTH, type BlockId } from "./contracts";
import { acceptsBlockChildren } from "./block-children-policy";
import { assertPortableXmlAttributes } from "./xml-subtree-codec";

export const BLOCK_CONTAINER_NODE_NAME = "blockContainer";
export const BLOCK_GROUP_NODE_NAME = "blockGroup";
export const BLOCK_ID_ATTRIBUTE = "id";

export interface ScannedDocumentBlock {
  readonly id: BlockId;
  readonly blockType: string;
  readonly parentBlockId: BlockId | null;
  readonly path: readonly number[];
  readonly text: string;
}

export type BlockStructureIssue =
  | {
      readonly code: "missing_block_id" | "invalid_block_id";
      readonly path: readonly number[];
    }
  | {
      readonly code: "duplicate_block_id";
      readonly blockId: BlockId;
      readonly path: readonly number[];
    }
  | {
      readonly code: "unsupported_xml_node";
      readonly nodeType: string;
      readonly path: readonly number[];
    }
  | {
      readonly code: "unexpected_xml_node";
      readonly expected: string;
      readonly actual: string;
      readonly path: readonly number[];
    }
  | {
      readonly code: "unsupported_xml_text_embed";
      readonly path: readonly number[];
    }
  | {
      readonly code: "unsupported_xml_value";
      readonly path: readonly number[];
    }
  | {
      readonly code: "xml_depth_exceeded";
      readonly path: readonly number[];
    };

export interface BlockStructureScan {
  readonly blocks: readonly ScannedDocumentBlock[];
  readonly issues: readonly BlockStructureIssue[];
}

export interface BlockChildrenViolation {
  readonly blockId: BlockId | null;
  readonly blockType: string;
}

export class BlockDocumentValidationError extends Error {
  readonly issues: readonly BlockStructureIssue[];

  constructor(issues: readonly BlockStructureIssue[]) {
    super(
      `Block document structure is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
    );
    this.name = "BlockDocumentValidationError";
    this.issues = issues;
  }
}

const getNodeType = (node: unknown): string => {
  if (typeof node !== "object" || node === null) {
    return typeof node;
  }

  return node.constructor.name;
};

const readBlockType = (container: Y.XmlElement): string => {
  const content = container
    .toArray()
    .find(
      (child): child is Y.XmlElement =>
        child instanceof Y.XmlElement && child.nodeName !== BLOCK_GROUP_NODE_NAME,
    );
  return content?.nodeName ?? "unknown";
};

const readContentElement = (container: Y.XmlElement): Y.XmlElement | undefined =>
  container
    .toArray()
    .find(
      (child): child is Y.XmlElement =>
        child instanceof Y.XmlElement && child.nodeName !== BLOCK_GROUP_NODE_NAME,
    );

export const blockContainerAcceptsChildren = (container: Y.XmlElement): boolean => {
  const content = readContentElement(container);
  if (!content) return false;
  return acceptsBlockChildren({
    type: content.nodeName,
    props: content.getAttributes(),
  });
};

export const collectBlockChildrenViolations = (
  body: Y.XmlFragment,
): readonly BlockChildrenViolation[] => {
  const violations: BlockChildrenViolation[] = [];
  const visit = (parent: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName !== BLOCK_CONTAINER_NODE_NAME) {
        visit(child);
        continue;
      }

      const content = readContentElement(child);
      const childGroup = child
        .toArray()
        .find(
          (candidate): candidate is Y.XmlElement =>
            candidate instanceof Y.XmlElement && candidate.nodeName === BLOCK_GROUP_NODE_NAME,
        );
      if (content && !blockContainerAcceptsChildren(child) && (childGroup?.length ?? 0) > 0) {
        const blockId = child.getAttribute(BLOCK_ID_ATTRIBUTE);
        violations.push({
          blockId: typeof blockId === "string" ? blockId : null,
          blockType: content.nodeName,
        });
      }
      if (childGroup) visit(childGroup);
    }
  };

  visit(body);
  return violations;
};

const attributeText = (element: Y.XmlElement, name: string): string => {
  const value: unknown = element.getAttribute(name);
  return typeof value === "string" ? value : "";
};

const readPlainText = (container: Y.XmlElement): string => {
  const content = container
    .toArray()
    .find(
      (child): child is Y.XmlElement =>
        child instanceof Y.XmlElement && child.nodeName !== BLOCK_GROUP_NODE_NAME,
    );
  if (!content) {
    return "";
  }
  // An image Block's text is its caption; an image within text contributes its description.
  if (content.nodeName === "image") {
    return attributeText(content, "caption");
  }
  const parts: string[] = [];
  for (const node of content.createTreeWalker(() => true)) {
    if (node instanceof Y.XmlElement && node.nodeName === "inlineImage") {
      parts.push(attributeText(node, "alt"));
    } else if (node instanceof Y.XmlText) {
      const text = (node.toDelta() as readonly { readonly insert: unknown }[])
        .flatMap((operation) => (typeof operation.insert === "string" ? [operation.insert] : []))
        .join("");
      parts.push(text);
    }
  }
  return parts.join("");
};

export const scanBlockDocument = (body: Y.XmlFragment): BlockStructureScan => {
  const blocks: ScannedDocumentBlock[] = [];
  const issues: BlockStructureIssue[] = [];
  const seenBlockIds = new Set<BlockId>();
  if (body.length !== 1) {
    issues.push({
      code: "unexpected_xml_node",
      expected: "exactly one root blockGroup",
      actual: `${body.length} root nodes`,
      path: [],
    });
  }

  const visit = (
    parent: Y.XmlFragment | Y.XmlElement,
    parentBlockId: BlockId | null,
    parentPath: readonly number[],
    context: "body" | "block_group" | "block_container" | "content",
  ): void => {
    const children: readonly unknown[] = parent.toArray();
    children.forEach((child, index) => {
      const path = [...parentPath, index];
      if (path.length > MAX_PAGE_DOCUMENT_XML_PATH_DEPTH) {
        issues.push({ code: "xml_depth_exceeded", path });
        return;
      }
      if (child instanceof Y.XmlText) {
        if (context !== "content") {
          issues.push({
            code: "unexpected_xml_node",
            expected: context === "block_group" ? BLOCK_CONTAINER_NODE_NAME : "element",
            actual: "XmlText",
            path,
          });
        }
        const delta = child.toDelta() as readonly {
          readonly insert: unknown;
          readonly attributes?: Readonly<Record<string, unknown>>;
        }[];
        if (delta.some((operation) => typeof operation.insert !== "string")) {
          issues.push({ code: "unsupported_xml_text_embed", path });
        }
        try {
          delta.forEach((operation) => {
            if (operation.attributes) {
              assertPortableXmlAttributes(operation.attributes);
            }
          });
        } catch {
          issues.push({ code: "unsupported_xml_value", path });
        }
        return;
      }

      if (!(child instanceof Y.XmlElement)) {
        issues.push({
          code: "unsupported_xml_node",
          nodeType: getNodeType(child),
          path,
        });
        return;
      }
      try {
        assertPortableXmlAttributes(child.getAttributes());
      } catch {
        issues.push({ code: "unsupported_xml_value", path });
      }

      let descendantParentId = parentBlockId;
      let childContext: "block_group" | "block_container" | "content" = "content";
      if (context === "body") {
        if (child.nodeName !== BLOCK_GROUP_NODE_NAME) {
          issues.push({
            code: "unexpected_xml_node",
            expected: BLOCK_GROUP_NODE_NAME,
            actual: child.nodeName,
            path,
          });
        }
        childContext = child.nodeName === BLOCK_GROUP_NODE_NAME ? "block_group" : "content";
      } else if (context === "block_group") {
        if (child.nodeName !== BLOCK_CONTAINER_NODE_NAME) {
          issues.push({
            code: "unexpected_xml_node",
            expected: BLOCK_CONTAINER_NODE_NAME,
            actual: child.nodeName,
            path,
          });
        }
        childContext = child.nodeName === BLOCK_CONTAINER_NODE_NAME ? "block_container" : "content";
      } else if (child.nodeName === BLOCK_GROUP_NODE_NAME) {
        if (context !== "block_container") {
          issues.push({
            code: "unexpected_xml_node",
            expected: "content element",
            actual: BLOCK_GROUP_NODE_NAME,
            path,
          });
        }
        childContext = "block_group";
      } else if (child.nodeName === BLOCK_CONTAINER_NODE_NAME) {
        issues.push({
          code: "unexpected_xml_node",
          expected: BLOCK_GROUP_NODE_NAME,
          actual: BLOCK_CONTAINER_NODE_NAME,
          path,
        });
        childContext = "block_container";
      }

      if (child.nodeName === BLOCK_CONTAINER_NODE_NAME) {
        const containerChildren = child.toArray();
        const contentChildren = containerChildren.filter(
          (containerChild): containerChild is Y.XmlElement =>
            containerChild instanceof Y.XmlElement &&
            containerChild.nodeName !== BLOCK_GROUP_NODE_NAME,
        );
        const childGroups = containerChildren.filter(
          (containerChild): containerChild is Y.XmlElement =>
            containerChild instanceof Y.XmlElement &&
            containerChild.nodeName === BLOCK_GROUP_NODE_NAME,
        );
        if (contentChildren.length !== 1) {
          issues.push({
            code: "unexpected_xml_node",
            expected: "exactly one Block content element",
            actual: `${contentChildren.length} content elements`,
            path,
          });
        }
        if (
          childGroups.length > 1 ||
          (childGroups.length === 1 &&
            containerChildren[containerChildren.length - 1] !== childGroups[0])
        ) {
          issues.push({
            code: "unexpected_xml_node",
            expected: "at most one trailing blockGroup",
            actual: `${childGroups.length} non-canonical blockGroup elements`,
            path,
          });
        }
        const rawBlockId: unknown = child.getAttribute(BLOCK_ID_ATTRIBUTE);
        if (rawBlockId === undefined || rawBlockId === null) {
          issues.push({ code: "missing_block_id", path });
        } else if (
          typeof rawBlockId !== "string" ||
          rawBlockId !== rawBlockId.trim() ||
          rawBlockId.trim().length === 0 ||
          rawBlockId.length > MAX_BLOCK_ID_LENGTH
        ) {
          issues.push({ code: "invalid_block_id", path });
        } else {
          const blockId: BlockId = rawBlockId;
          if (seenBlockIds.has(blockId)) {
            issues.push({ code: "duplicate_block_id", blockId, path });
          } else {
            seenBlockIds.add(blockId);
            blocks.push({
              id: blockId,
              blockType: readBlockType(child),
              parentBlockId,
              path,
              text: readPlainText(child),
            });
          }
          descendantParentId = blockId;
        }
      }

      visit(child, descendantParentId, path, childContext);
    });
  };

  visit(body, null, [], "body");
  return { blocks, issues };
};

export const assertValidBlockDocument = (body: Y.XmlFragment): readonly ScannedDocumentBlock[] => {
  const scan = scanBlockDocument(body);
  if (scan.issues.length > 0) {
    throw new BlockDocumentValidationError(scan.issues);
  }

  return scan.blocks;
};
