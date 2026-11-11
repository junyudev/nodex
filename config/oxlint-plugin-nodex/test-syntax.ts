import { isAbsolute, relative } from "node:path";
import type { Context, ESTree } from "@oxlint/plugins";
import { getPropertyName, importedBinding, memberName, unwrapExpression } from "./utils.ts";

export function testPath(context: Context): string | null {
  const filename = isAbsolute(context.filename)
    ? relative(context.cwd, context.filename)
    : context.filename;
  const path = filename.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (/^(?:third_party|packages\/agent-runtime\/vendor)\//u.test(path)) return null;
  if (/\.(?:test\.tsx?|spec\.ts)$/u.test(path)) return path;
  if (
    /^(?:tests\/(?:e2e|fixtures)|src\/renderer\/test)\//u.test(path) &&
    /\.[cm]?[jt]sx?$/u.test(path)
  )
    return path;
  return null;
}

const TEST_MODULES = new Set([
  "vitest",
  "vite-plus/test",
  "@effect/vitest",
  "@playwright/test",
  "node:test",
]);
const TEST_NAMES = new Set([
  "test",
  "it",
  "describe",
  "suite",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "before",
  "after",
  "expect",
  "vi",
  "vitest",
]);

export function testApiName(context: Context, node: ESTree.Node): string | null {
  if (node.type !== "Identifier") return null;
  const imported = importedBinding(context, node);
  if (imported) return TEST_MODULES.has(imported.source) ? imported.name : null;
  return TEST_NAMES.has(node.name) ? node.name : null;
}

export function callChain(context: Context, callee: unknown): readonly string[] {
  const expression = unwrapExpression(callee);
  if (!expression) return [];
  if (expression.type === "CallExpression") return callChain(context, expression.callee);
  if (expression.type === "MemberExpression") {
    const name = memberName(expression);
    const base = callChain(context, expression.object);
    if (!name || base.length === 0) return [];
    return base[0] === "*" ? [name] : [...base, name];
  }
  const root = testApiName(context, expression);
  return root ? [root] : [];
}

export const TEST_REGISTRATIONS = new Set(["test", "it", "describe", "suite"]);
export const HOOKS = new Set([
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "before",
  "after",
]);

export function option(argument: unknown, name: string) {
  const expression = unwrapExpression(argument);
  if (expression?.type !== "ObjectExpression") return undefined;
  for (const property of expression.properties) {
    if (property.type !== "Property" || (property.computed && property.key.type !== "Literal"))
      continue;
    if (getPropertyName(property.key) === name) return property;
  }
  return undefined;
}

export function isFunction(
  node: ESTree.Node,
): node is Extract<
  ESTree.Node,
  { type: "ArrowFunctionExpression" | "FunctionExpression" | "FunctionDeclaration" }
> {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}
