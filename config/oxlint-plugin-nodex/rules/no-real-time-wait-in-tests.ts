import { defineRule, type Context, type ESTree } from "@oxlint/plugins";
import { callChain, testPath } from "../test-syntax.ts";
import { isCallbackTimer, isDelayCall, isInsidePromiseExecutor, isPromise } from "../test-waits.ts";

import { isIdentifier, memberName, unwrapExpression } from "../utils.ts";

function isLiveEffectDelay(context: Context, node: ESTree.CallExpression): boolean {
  const callee = unwrapExpression(node.callee);
  if (callee?.type !== "MemberExpression") return false;
  const name = memberName(callee);
  if (name !== "sleep" && name !== "delay") return false;
  if (!isIdentifier(unwrapExpression(callee.object), "Effect")) return false;

  let child: ESTree.Node = node;
  for (let parent: ESTree.Node | null = node.parent; parent; parent = parent.parent) {
    if (parent.type === "CallExpression" && parent.callee !== child) {
      const [root, ...methods] = callChain(context, parent.callee);
      if (root === "it" || root === "test")
        return methods.includes("live") || methods.includes("scopedLive");
    }
    child = parent;
  }
  return false;
}

const MESSAGE =
  "Await the event or observable state that marks completion, or drive a test clock when testing timer behavior.";

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow fixed real-time waits in tests and test helpers." },
  },
  create(context) {
    if (!testPath(context)) return {};
    return {
      NewExpression(node) {
        if (!isPromise(node) || !isCallbackTimer(node.arguments[0])) return;
        context.report({ node, message: MESSAGE });
      },
      CallExpression(node) {
        if (
          !isDelayCall(context, node) &&
          !isLiveEffectDelay(context, node) &&
          !(isCallbackTimer(node.callee) && isInsidePromiseExecutor(node))
        )
          return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
