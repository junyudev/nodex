import { defineRule } from "@oxlint/plugins";
import { getPropertyName, unwrapExpression } from "../utils.ts";

const LISTENER_METHODS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
  "off",
  "removeListener",
]);

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Share WebContents destruction through the scoped Main platform owner." },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (
      !/(?:^|\/)src\/main\//u.test(filename) &&
      !/(?:^|\/)scripts\/fixtures\/tooling\/nodex\/webcontents-lifetime-/u.test(filename)
    )
      return {};
    if (/\.(?:node\.)?test(?:-support)?\.[cm]?[jt]sx?$/u.test(filename)) return {};
    // This adapter is the sole native destruction listener owner, including sandbox guests.
    if (filename.endsWith("/src/main/platform/electron/WebContentsDestructionSubscriptions.ts"))
      return {};
    return {
      ImportSpecifier(node) {
        if (getPropertyName(node.imported) !== "makeWebContentsDestructionSubscriptions") return;
        context.report({
          node,
          message:
            "Borrow WebContentsDestructionSubscriptions.live so Main owners share one native listener registry.",
        });
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (callee?.type !== "MemberExpression") return;
        const method = getPropertyName(callee.property);
        if (!method || !LISTENER_METHODS.has(method)) return;
        const event = unwrapExpression(node.arguments[0]);
        const name =
          event?.type === "Literal"
            ? event.value
            : event?.type === "TemplateLiteral" && event.expressions.length === 0
              ? event.quasis[0]?.value.cooked
              : null;
        if (name !== "destroyed") return;
        context.report({
          node,
          message:
            "Use WebContentsDestructionSubscriptions; release the registration with its request, subscription, or adapter Scope.",
        });
      },
    };
  },
});
