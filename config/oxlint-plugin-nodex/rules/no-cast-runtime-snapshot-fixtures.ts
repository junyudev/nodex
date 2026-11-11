import { defineRule } from "@oxlint/plugins";
import { unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/u;
const RUNTIME_SNAPSHOT_TYPES = new Set(["AgentSnapshot", "AgentRuntimeConversation"]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Build Agent Runtime snapshots in tests from the typed fixture, so a new Runtime field fails typecheck instead of a test at run time.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      TSAsExpression(node) {
        const type = node.typeAnnotation;
        if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return;
        if (!RUNTIME_SNAPSHOT_TYPES.has(type.typeName.name)) return;
        if (unwrapExpression(node.expression)?.type !== "ObjectExpression") return;

        context.report({
          node,
          message: `Do not cast an object literal to ${type.typeName.name}. Build the snapshot with agentRuntimeSnapshotFixture from src/shared/testing/agent-runtime-snapshot.ts, and confine partial rows to agentRuntimeRow.`,
        });
      },
    };
  },
});
