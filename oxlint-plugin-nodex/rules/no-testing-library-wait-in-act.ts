import { defineRule, type Context, type ESTree, type Scope } from "@oxlint/plugins";
import { dirname, resolve } from "node:path";
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
// These test helpers preserve Testing Library's RenderResult while supplying Nodex scopes.
const SHARED_RENDER_FACTORIES = new Map([
  ["/src/renderer/test/app-maitai", "renderWithAppMaitai"],
  ["/src/renderer/test/thread-maitai", "renderWithMaitai"],
  ["/src/renderer/test/dom", "render"],
]);

const memberName = (node: ESTree.MemberExpression): string | null =>
  node.computed && node.property.type !== "Literal" ? null : getPropertyName(node.property);

const bindingVariable = (context: Context, node: ESTree.Node) => {
  if (node.type !== "Identifier") return null;
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (!variable) {
      scope = scope.upper;
      continue;
    }
    return variable;
  }
  return null;
};

const bindingDefinition = (context: Context, node: ESTree.Node) =>
  bindingVariable(context, node)?.defs[0] ?? null;

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

const isSharedRenderFactory = (
  context: Context,
  binding: ReturnType<typeof importedOperation>,
): boolean => {
  if (!binding?.name) return false;
  if (!binding.source.startsWith("@/") && !binding.source.startsWith(".")) return false;
  const source = (
    binding.source.startsWith("@/")
      ? `/src/renderer/${binding.source.slice(2)}`
      : resolve(dirname(context.filename), binding.source)
  )
    .replaceAll("\\", "/")
    .replace(/\.[cm]?[jt]sx?$/u, "");
  return [...SHARED_RENDER_FACTORIES].some(
    ([suffix, name]) => source.endsWith(suffix) && binding.name === name,
  );
};

const stableLocalDeclaration = (context: Context, node: ESTree.Node) => {
  const variable = bindingVariable(context, node);
  if (!variable || variable.references.some((reference) => reference.isWrite() && !reference.init))
    return null;
  const declaration = variable.defs[0]?.node;
  if (declaration?.type === "FunctionDeclaration") return declaration;
  if (
    declaration?.type === "VariableDeclarator" &&
    declaration.parent.type === "VariableDeclaration" &&
    declaration.parent.kind === "const"
  ) {
    return declaration;
  }
  return null;
};

/** Follow immutable local aliases and direct render wrappers, never unknown receiver names. */
const isQuerySource = (context: Context, node: unknown, seen = new Set<ESTree.Node>()): boolean => {
  const expression = unwrapExpression(node);
  if (!expression || seen.has(expression)) return false;
  seen.add(expression);
  const binding = importedOperation(context, expression);
  if (binding?.source.startsWith("@testing-library/")) {
    return binding.name === "screen" || binding.name === "*";
  }
  if (expression.type === "CallExpression") return isQueryFactory(context, expression.callee, seen);
  const declaration = stableLocalDeclaration(context, expression);
  return declaration?.type === "VariableDeclarator"
    ? isQuerySource(context, declaration.init, seen)
    : false;
};

const isQueryFactory = (context: Context, node: unknown, seen: Set<ESTree.Node>): boolean => {
  const expression = unwrapExpression(node);
  if (!expression || seen.has(expression)) return false;
  seen.add(expression);
  const binding = importedOperation(context, expression);
  if (binding?.source.startsWith("@testing-library/"))
    return binding.name === "render" || binding.name === "within";
  if (isSharedRenderFactory(context, binding)) return true;
  const declaration = stableLocalDeclaration(context, expression);
  const callable =
    declaration?.type === "VariableDeclarator" ? unwrapExpression(declaration.init) : declaration;
  if (!callable) return false;
  if (
    callable.type !== "ArrowFunctionExpression" &&
    callable.type !== "FunctionExpression" &&
    callable.type !== "FunctionDeclaration"
  ) {
    return isQueryFactory(context, callable, seen);
  }
  const body = callable.body;
  if (body?.type !== "BlockStatement") return isQuerySource(context, body, seen);
  const statement = body.body.length === 1 ? body.body[0] : null;
  return statement?.type === "ReturnStatement"
    ? isQuerySource(context, statement.argument, seen)
    : false;
};

const destructuredQuery = (context: Context, node: ESTree.Node): string | null => {
  const declaration = stableLocalDeclaration(context, node);
  if (declaration?.type !== "VariableDeclarator" || declaration.id.type !== "ObjectPattern")
    return null;
  if (!isQuerySource(context, declaration.init)) return null;
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
        if (
          ASYNC_QUERY.test(name) &&
          callee.type === "MemberExpression" &&
          !isQuerySource(context, callee.object)
        ) {
          return;
        }
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
