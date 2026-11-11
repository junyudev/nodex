import { defineRule, type Context, type ESTree } from "@oxlint/plugins";
import { callChain, testPath } from "../test-syntax.ts";
import { bindingDefinition, memberName, unwrapExpression } from "../utils.ts";

const COMPARISONS = new Set(["<", "<=", ">", ">=", "===", "!==", "==", "!="]);
const MATCHERS = new Set([
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBe",
  "toEqual",
  "toBeCloseTo",
]);

function followConst(
  context: Context,
  value: unknown,
  matches: (node: ESTree.Node) => boolean,
  seen = new Set<ESTree.Node>(),
): boolean {
  const node = unwrapExpression(value);
  if (!node || seen.has(node)) return false;
  if (node.type !== "Identifier") return matches(node);
  seen.add(node);
  const declaration = bindingDefinition(context, node)?.node;
  return (
    declaration?.type === "VariableDeclarator" &&
    declaration.parent.type === "VariableDeclaration" &&
    declaration.parent.kind === "const" &&
    followConst(context, declaration.init, matches, seen)
  );
}

function isClockReading(context: Context, value: unknown): boolean {
  return followConst(context, value, (node) => {
    if (node.type !== "CallExpression") return false;
    const callee = unwrapExpression(node.callee);
    if (callee?.type !== "MemberExpression" || memberName(callee) !== "now") return false;
    const receiver = unwrapExpression(callee.object);
    return (
      receiver?.type === "Identifier" &&
      (receiver.name === "Date" || receiver.name === "performance") &&
      !bindingDefinition(context, receiver)
    );
  });
}

function isElapsed(context: Context, value: unknown): boolean {
  return followConst(
    context,
    value,
    (node) =>
      node.type === "BinaryExpression" &&
      node.operator === "-" &&
      isClockReading(context, node.left) &&
      isClockReading(context, node.right),
  );
}

function assertionInput(context: Context, callee: ESTree.MemberExpression) {
  let receiver = unwrapExpression(callee.object);
  while (receiver?.type === "MemberExpression") receiver = unwrapExpression(receiver.object);
  if (receiver?.type === "CallExpression" && callChain(context, receiver.callee)[0] === "expect") {
    return receiver.arguments[0];
  }
  return null;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep elapsed wall-clock budgets in performance and stress tests." },
  },
  create(context) {
    const path = testPath(context);
    if (
      !path ||
      /\.stress(?:\.[^.\/]+)*\.test\.tsx?$/u.test(path) ||
      /^tests\/e2e\/.*(?:-performance|-benchmark)\.spec\.ts$/u.test(path)
    )
      return {};
    const report = (node: ESTree.Node) =>
      context.report({
        node,
        message:
          "Assert on the outcome or drive a test clock. Put elapsed-time budgets in the performance or stress tier.",
      });
    return {
      BinaryExpression(node) {
        if (!COMPARISONS.has(node.operator)) return;
        if (isElapsed(context, node.left) || isElapsed(context, node.right)) report(node);
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (callee?.type !== "MemberExpression" || !MATCHERS.has(memberName(callee) ?? "")) return;
        if (isElapsed(context, assertionInput(context, callee))) report(node);
      },
    };
  },
});
