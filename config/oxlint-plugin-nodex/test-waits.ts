import type { Context, ESTree } from "@oxlint/plugins";
import { isFunction } from "./test-syntax.ts";
import { importedBinding, memberName, isIdentifier, unwrapExpression } from "./utils.ts";

const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const GLOBALS = new Set(["window", "globalThis", "self"]);
const SLEEP_HELPER = /^(?:sleep|delay|pause|waitMs)$/u;

export function isCallbackTimer(callee: unknown): boolean {
  const expression = unwrapExpression(callee);
  if (expression?.type === "Identifier") return TIMERS.has(expression.name);
  if (expression?.type !== "MemberExpression") return false;
  const object = unwrapExpression(expression.object);
  return (
    object?.type === "Identifier" &&
    GLOBALS.has(object.name) &&
    TIMERS.has(memberName(expression) ?? "")
  );
}

export function isPromise(node: ESTree.Node | null): node is ESTree.NewExpression {
  return node?.type === "NewExpression" && isIdentifier(unwrapExpression(node.callee), "Promise");
}

// Promise timers and conventional awaited delay helpers. Effect.sleep can run
// on a TestClock, so its presence alone does not establish a real-time wait.
export function isDelayCall(context: Context, call: ESTree.CallExpression): boolean {
  const callee = unwrapExpression(call.callee);
  if (!callee) return false;
  if (callee.type === "MemberExpression" && memberName(callee) === "waitForTimeout") return true;
  const receiver = callee.type === "MemberExpression" ? callee.object : callee;
  const imported = importedBinding(context, receiver);
  if (imported && /^(?:node:)?timers\/promises$/u.test(imported.source)) {
    const name = callee.type === "MemberExpression" ? memberName(callee) : imported.name;
    return TIMERS.has(name ?? "");
  }
  return (
    callee.type === "Identifier" &&
    call.parent?.type === "AwaitExpression" &&
    SLEEP_HELPER.test(callee.name)
  );
}

export function isInsidePromiseExecutor(node: ESTree.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!isFunction(current)) continue;
    return isPromise(current.parent) && current.parent.arguments[0] === current;
  }
  return false;
}

// Like the lint visitor, traverse only AST children, and stop at callbacks
// whose waits and exits are not part of the surrounding loop.
export function someDescendant(
  context: Context,
  value: unknown,
  match: (node: ESTree.Node) => boolean,
): boolean {
  if (Array.isArray(value)) return value.some((child) => someDescendant(context, child, match));
  const node = unwrapExpression(value);
  if (!node || isFunction(node)) return false;
  if (match(node)) return true;
  return (context.sourceCode.visitorKeys[node.type] ?? []).some((key) =>
    someDescendant(context, (node as unknown as Record<string, unknown>)[key], match),
  );
}
