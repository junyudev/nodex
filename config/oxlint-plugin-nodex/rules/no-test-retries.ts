import { defineRule } from "@oxlint/plugins";
import { callChain, option, TEST_REGISTRATIONS, testPath } from "../test-syntax.ts";

const retry = (argument: unknown) => option(argument, "retry") || option(argument, "retries");

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep runner retry policy out of individual tests and suites." },
  },
  create(context) {
    if (!testPath(context)) return {};
    return {
      CallExpression(node) {
        const [root = "", method, operation] = callChain(context, node.callee);
        const [first, second, third] = node.arguments;
        const retryOption =
          TEST_REGISTRATIONS.has(root) &&
          (retry(second) || retry(third) || (operation === "configure" && retry(first)));
        if (!retryOption && !(root === "vi" && method === "setConfig" && retry(first))) return;
        context.report({
          node,
          message: "Remove the retry override and await the condition the test depends on.",
        });
      },
    };
  },
});
