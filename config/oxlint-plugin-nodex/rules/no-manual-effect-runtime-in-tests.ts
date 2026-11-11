import { defineRule } from "@oxlint/plugins";
import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/u;
const EFFECT_RUNTIME_METHODS = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
]);

const manualRunnerName = (callee: unknown): string | null => {
  const expression = unwrapExpression(callee);
  if (expression?.type !== "MemberExpression") return null;

  const object = unwrapExpression(expression.object);
  const property = getPropertyName(expression.property);
  if (!property) return null;

  if (isIdentifier(object, "Effect") && EFFECT_RUNTIME_METHODS.has(property)) {
    return `Effect.${property}`;
  }
  if (isIdentifier(object, "ManagedRuntime") && property === "make") {
    return "ManagedRuntime.make";
  }
  return null;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep Effect test and test-support execution inside the project-owned @effect/vitest lifecycle.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      CallExpression(node) {
        const runner = manualRunnerName(node.callee);
        if (!runner) return;

        context.report({
          node: node.callee,
          message: `Do not use ${runner} in tests. Use @effect/vitest with it.effect(...) and test layers instead.`,
        });
      },
    };
  },
});
