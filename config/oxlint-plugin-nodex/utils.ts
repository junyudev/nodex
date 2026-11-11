import type { Context, ESTree, Scope } from "@oxlint/plugins";

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

export const memberName = (node: ESTree.MemberExpression): string | null =>
  node.computed && node.property.type !== "Literal" ? null : getPropertyName(node.property);

export function bindingVariable(context: Context, node: ESTree.Node) {
  if (node.type !== "Identifier") return null;
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

export const bindingDefinition = (context: Context, node: ESTree.Node) =>
  bindingVariable(context, node)?.defs[0] ?? null;

export function importedBinding(context: Context, node: ESTree.Node) {
  const definition = bindingDefinition(context, node);
  if (definition?.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration")
    return null;
  return {
    source: definition.parent.source.value,
    name:
      definition.node.type === "ImportSpecifier" ? getPropertyName(definition.node.imported) : "*",
  };
}
