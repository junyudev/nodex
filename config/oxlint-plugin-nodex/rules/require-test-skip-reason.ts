import { defineRule, type ESTree } from "@oxlint/plugins";
import { callChain, option, TEST_REGISTRATIONS, testPath } from "../test-syntax.ts";
import { unwrapExpression } from "../utils.ts";

const SKIP_METHODS = new Set(["skip", "todo", "fixme"]);

function isEnabled(argument: unknown, name: string): boolean {
  const value = unwrapExpression(option(argument, name)?.value);
  return value?.type === "Literal" && value.value === true;
}

function hasPlaywrightReason(args: ESTree.CallExpression["arguments"]): boolean {
  const [condition, description] = args.map(unwrapExpression);
  return condition?.type !== "Literal" || typeof condition.value !== "string"
    ? description?.type === "Literal" &&
        typeof description.value === "string" &&
        /\S/u.test(description.value)
    : false;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Record why a test or suite is skipped or deferred." },
  },
  create(context) {
    if (!testPath(context)) return {};
    return {
      CallExpression(node) {
        const [root = "", ...methods] = callChain(context, node.callee);
        if (!TEST_REGISTRATIONS.has(root)) return;
        // A curried registration is diagnosed once, at its outer call.
        if (node.parent?.type === "CallExpression" && node.parent.callee === node) return;
        const [, second, third] = node.arguments;
        const skip = methods.some((method) => SKIP_METHODS.has(method));
        if (
          !skip &&
          ![second, third].some((arg) => [...SKIP_METHODS].some((method) => isEnabled(arg, method)))
        )
          return;
        if (
          skip &&
          methods.some((method) => method === "skip" || method === "fixme") &&
          hasPlaywrightReason(node.arguments)
        )
          return;
        const statement = node.parent?.type === "ExpressionStatement" ? node.parent : node;
        const comments = [
          ...context.sourceCode.getCommentsBefore(statement),
          ...context.sourceCode
            .getCommentsAfter(statement)
            .filter((comment) => comment.loc.start.line === statement.loc.end.line),
        ];
        if (
          comments.some(
            (comment) =>
              comment.loc.end.line >= statement.loc.start.line - 1 &&
              /[\p{L}\p{N}]{2}/u.test(comment.value) &&
              !/^\s*(?:(?:oxlint|eslint)-|(?:TODO|FIXME|skip)\W*$)/iu.test(comment.value),
          )
        )
          return;
        context.report({
          node,
          message:
            "Explain the skip or deferral in an adjacent comment or the Playwright reason argument.",
        });
      },
    };
  },
});
