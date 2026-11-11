import { defineRule, type Context, type ESTree } from "@oxlint/plugins";
import { isFunction, testPath } from "../test-syntax.ts";
import { isCallbackTimer, isDelayCall, isPromise, someDescendant } from "../test-waits.ts";
import { memberName, isIdentifier, unwrapExpression } from "../utils.ts";

type ConditionalLoop = ESTree.ForStatement | ESTree.WhileStatement | ESTree.DoWhileStatement;
type Loop = ConditionalLoop | Extract<ESTree.Node, { type: "ForOfStatement" | "ForInStatement" }>;

function isMember(node: unknown, root: string, name: string): boolean {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "MemberExpression" &&
    isIdentifier(unwrapExpression(expression.object), root) &&
    memberName(expression) === name
  );
}

function isWait(context: Context, node: ESTree.Node): boolean {
  if (node.type === "YieldExpression" && isMember(node.argument, "Effect", "yieldNow")) return true;
  if (node.type !== "AwaitExpression" && node.type !== "YieldExpression") return false;
  const argument = unwrapExpression(node.argument);
  if (argument?.type === "CallExpression") {
    return (
      isDelayCall(context, argument) ||
      isMember(argument.callee, "Promise", "resolve") ||
      isMember(argument.callee, "Effect", "sleep")
    );
  }
  if (!isPromise(argument)) return false;
  const executor = unwrapExpression(argument.arguments[0]);
  return (
    isCallbackTimer(executor) ||
    Boolean(
      executor &&
      isFunction(executor) &&
      someDescendant(
        context,
        executor.body,
        (child) => child.type === "CallExpression" && isCallbackTimer(child.callee),
      ),
    )
  );
}

function isCounterBound(context: Context, loop: ConditionalLoop): boolean {
  const condition = unwrapExpression(loop.test);
  if (
    condition?.type !== "BinaryExpression" ||
    !["<", "<=", ">", ">="].includes(condition.operator)
  )
    return false;
  return [
    [condition.left, condition.right],
    [condition.right, condition.left],
  ].some(
    ([counter, bound]) =>
      counter?.type === "Identifier" &&
      (bound?.type === "Identifier" ||
        (bound?.type === "Literal" && typeof bound.value === "number")) &&
      someDescendant(
        context,
        [loop.body, loop.type === "ForStatement" ? loop.update : null],
        (node) =>
          (node.type === "UpdateExpression" &&
            isIdentifier(unwrapExpression(node.argument), counter.name)) ||
          (node.type === "AssignmentExpression" &&
            (node.operator === "+=" || node.operator === "-=") &&
            isIdentifier(unwrapExpression(node.left), counter.name)),
      ),
  );
}

function hasPredicate(context: Context, loop: Loop): boolean {
  const condition = "test" in loop ? unwrapExpression(loop.test) : null;
  if (
    condition &&
    "test" in loop &&
    !(condition.type === "Literal" && condition.value === true) &&
    !isCounterBound(context, loop)
  )
    return true;
  return someDescendant(
    context,
    loop.body,
    (node) =>
      (node.type === "IfStatement" || node.type === "TryStatement") &&
      someDescendant(
        context,
        node,
        (child) =>
          child.type === "ReturnStatement" ||
          child.type === "BreakStatement" ||
          child.type === "ThrowStatement",
      ),
  );
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow hand-written polling loops in tests." },
  },
  create(context) {
    if (!testPath(context)) return {};
    const check = (node: Loop) => {
      if (!someDescendant(context, node.body, (child) => isWait(context, child))) return;
      if (!hasPredicate(context, node)) return;
      context.report({
        node,
        message:
          "Await the completion signal or use a shared retrying assertion instead of polling in a loop.",
      });
    };
    return {
      WhileStatement: check,
      DoWhileStatement: check,
      ForStatement: check,
      ForOfStatement: check,
      ForInStatement: check,
    };
  },
});
