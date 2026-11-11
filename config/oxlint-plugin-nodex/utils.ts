import type { ESTree } from "@oxlint/plugins";

type ExpressionWrapper =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSAsExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSTypeAssertion;

type AstNode = ESTree.Node;

const asAstNode = (node: unknown): AstNode | null => {
  if (typeof node !== "object" || node === null) return null;
  if (!("type" in node) || typeof node.type !== "string") return null;
  return node as AstNode;
};

const isExpressionWrapper = (node: AstNode): node is ExpressionWrapper =>
  node.type === "ChainExpression" ||
  node.type === "ParenthesizedExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSTypeAssertion";

export const unwrapExpression = (node: unknown): AstNode | null => {
  let current = asAstNode(node);

  while (current && isExpressionWrapper(current)) {
    current = asAstNode(current.expression);
  }

  return current;
};

export const getPropertyName = (node: unknown): string | null => {
  const expression = asAstNode(node);
  if (!expression) return null;

  if (
    (expression.type === "Identifier" || expression.type === "PrivateIdentifier") &&
    typeof expression.name === "string"
  ) {
    return expression.name;
  }
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  return null;
};

export const isIdentifier = (node: AstNode | null, name: string): boolean =>
  node?.type === "Identifier" && node.name === name;
