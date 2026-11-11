import { defineRule, type Context, type ESTree } from "@oxlint/plugins";
import { callChain, HOOKS, option, TEST_REGISTRATIONS, testPath } from "../test-syntax.ts";
import { bindingDefinition, importedBinding, memberName, unwrapExpression } from "../utils.ts";

const ASYNC_QUERY =
  /^find(?:All)?By(?:Role|Text|LabelText|PlaceholderText|Title|AltText|DisplayValue|TestId)$/u;
const DOM_WAIT = new Set(["waitFor", "waitForElementToBeRemoved"]);
const VI_WAIT = new Set(["waitFor", "waitUntil"]);

// Use the option position of retrying Playwright matchers. Generic matchers
// such as toEqual can legitimately assert on an object containing a timeout.
const PLAYWRIGHT_MATCHER =
  /^to(?:Be(?:Attached|Checked|Disabled|Editable|Empty|Enabled|Focused|Hidden|InViewport|Visible)|Contain(?:Class|Text)|Have(?:Accessible(?:Description|ErrorMessage|Name)|Attribute|Class|Count|CSS|Id|JSProperty|Role|Screenshot|Text|Title|URL|Values?)|MatchAriaSnapshot|Pass)$/u;

function numericArgument(context: Context, argument: unknown): boolean {
  const expression = unwrapExpression(argument);
  if (expression?.type === "Literal") return typeof expression.value === "number";
  if (expression?.type !== "Identifier") return false;
  const declaration = bindingDefinition(context, expression)?.node;
  if (
    declaration?.type !== "VariableDeclarator" ||
    declaration.parent.type !== "VariableDeclaration" ||
    declaration.parent.kind !== "const"
  )
    return false;
  const value = unwrapExpression(declaration.init);
  return value?.type === "Literal" && typeof value.value === "number";
}

function waitTimeout(context: Context, call: ESTree.CallExpression, playwright: boolean): boolean {
  const callee = unwrapExpression(call.callee);
  if (!callee) return false;
  const [first, second, third] = call.arguments;
  const imported = callee.type === "Identifier" ? importedBinding(context, callee) : null;
  const name =
    callee.type === "MemberExpression"
      ? memberName(callee)
      : callee.type === "Identifier"
        ? (imported?.name ?? callee.name)
        : null;
  if (!name) return false;
  if (ASYNC_QUERY.test(name)) {
    return Boolean(
      option(third, "timeout") ||
      (callee.type === "Identifier" && option(call.arguments[3], "timeout")),
    );
  }
  const [root, method] = callChain(context, callee);
  if (root === "vi" || root === "vitest") {
    return Boolean(
      method &&
      VI_WAIT.has(method) &&
      (option(second, "timeout") || numericArgument(context, second)),
    );
  }
  if (root === "expect" && method === "poll") return Boolean(option(second, "timeout"));
  if (root === "expect" && method === "configure" && playwright)
    return Boolean(option(first, "timeout"));
  if (root === "expect" && PLAYWRIGHT_MATCHER.test(name) && playwright) {
    const options = call.arguments.at(-1);
    if (name === "toHaveJSProperty" && call.arguments.length !== 3) return false;
    return Boolean(option(options, "timeout"));
  }
  if (DOM_WAIT.has(name) && option(second, "timeout")) return true;
  return (
    playwright &&
    callee.type === "MemberExpression" &&
    name === "waitFor" &&
    Boolean(option(first, "timeout"))
  );
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Let tests and positive waits inherit their runner's timeout defaults." },
  },
  create(context) {
    const path = testPath(context);
    if (!path) return {};
    return {
      CallExpression(node) {
        const [root = "", method, operation] = callChain(context, node.callee);
        const [first, second, third] = node.arguments;
        const timeout =
          (TEST_REGISTRATIONS.has(root) &&
            ((method === "setTimeout" && first !== undefined) ||
              (operation === "configure" && Boolean(option(first, "timeout"))) ||
              numericArgument(context, third) ||
              Boolean(option(second, "timeout") || option(third, "timeout")))) ||
          (HOOKS.has(root) &&
            (numericArgument(context, second) || Boolean(option(second, "timeout")))) ||
          (root === "vi" &&
            method === "setConfig" &&
            Boolean(option(first, "testTimeout") || option(first, "hookTimeout"))) ||
          waitTimeout(context, node, path.startsWith("tests/e2e/") || path.endsWith(".spec.ts"));
        if (!timeout) return;
        context.report({
          node,
          message:
            "Use the shared timeout default. If this wait is expected to time out or needs a different budget, explain why in an inline exception.",
        });
      },
    };
  },
});
