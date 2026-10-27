import { defineRule, type Context, type ESTree, type Scope } from "@oxlint/plugins";
import { getPropertyName, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/u;
const ACT_MODULES = new Set([
  "react",
  "react-dom/test-utils",
  "@testing-library/react",
  "@testing-library/react/pure",
]);
const ASYNC_QUERY =
  /^find(?:All)?By(?:Role|Text|LabelText|PlaceholderText|Title|AltText|DisplayValue|TestId)$/u;
const ASYNC_WAIT = /^waitFor(?:ElementToBeRemoved)?$/u;

const memberName = (node: ESTree.MemberExpression): string | null =>
  node.computed && node.property.type !== "Literal" ? null : getPropertyName(node.property);

const bindingDefinition = (context: Context, node: ESTree.Node) => {
  if (node.type !== "Identifier") return null;
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (!variable) {
      scope = scope.upper;
      continue;
    }
    return variable.defs[0] ?? null;
  }
  return null;
};

/** Resolve the actual import so local functions and shadowed act parameters stay legal. */
const importedBinding = (context: Context, node: ESTree.Node) => {
  const definition = bindingDefinition(context, node);
  if (definition?.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration")
    return null;
  return {
    source: definition.parent.source.value,
    name:
      definition.node.type === "ImportSpecifier" ? getPropertyName(definition.node.imported) : "*",
  };
};

const importedOperation = (context: Context, node: ESTree.Node) => {
  const expression = unwrapExpression(node);
  if (!expression) return null;
  if (expression.type !== "MemberExpression") return importedBinding(context, expression);
  const object = unwrapExpression(expression.object);
  const binding = object ? importedBinding(context, object) : null;
  return binding?.name === "*" ? { ...binding, name: memberName(expression) } : null;
};

const destructuredQuery = (context: Context, node: ESTree.Node): string | null => {
  const declaration = bindingDefinition(context, node)?.node;
  if (declaration?.type !== "VariableDeclarator" || declaration.id.type !== "ObjectPattern")
    return null;
  const initializer = unwrapExpression(declaration.init);
  if (!initializer) return null;
  const source = importedOperation(
    context,
    initializer.type === "CallExpression" ? initializer.callee : initializer,
  );
  if (!source?.source.startsWith("@testing-library/")) return null;
  if (source.name !== "screen" && source.name !== "render" && source.name !== "within") return null;
  const property = declaration.id.properties.find(
    (entry) => entry.type === "Property" && getPropertyName(entry.value) === getPropertyName(node),
  );
  return property?.type === "Property" ? getPropertyName(property.key) : null;
};

const isAct = (context: Context, node: ESTree.Node): boolean => {
  const binding = importedOperation(context, node);
  return binding?.name === "act" && ACT_MODULES.has(binding.source);
};

const isDirectActCallback = (context: Context, node: ESTree.Node): boolean => {
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === "ArrowFunctionExpression" ||
      parent.type === "FunctionExpression" ||
      parent.type === "FunctionDeclaration"
    ) {
      const call = parent.parent;
      return (
        call?.type === "CallExpression" &&
        unwrapExpression(call.arguments[0]) === parent &&
        isAct(context, call.callee)
      );
    }
    parent = parent.parent;
  }
  return false;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Wait for Testing Library DOM observations after React act has flushed updates.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (!callee) return;
        const binding = importedOperation(context, callee);
        const name =
          callee.type === "MemberExpression"
            ? memberName(callee)
            : binding?.source.startsWith("@testing-library/")
              ? binding.name
              : destructuredQuery(context, callee);
        if (!name || (!ASYNC_QUERY.test(name) && !ASYNC_WAIT.test(name))) return;
        if (ASYNC_WAIT.test(name) && callee.type === "MemberExpression") {
          if (!binding?.source.startsWith("@testing-library/")) return;
        }
        if (!isDirectActCallback(context, node)) return;

        context.report({
          node,
          message:
            "Wait for findBy*, findAllBy*, and waitFor* outside act. Keep act around the interaction, then await the resulting DOM state after React flushes its updates.",
        });
      },
    };
  },
});
