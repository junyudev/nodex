import { defineRule } from "@oxlint/plugins";
import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const PROFILE_SETTINGS_FILE_PATTERN =
  /(?:^|\/)(?:src\/main\/settings\/|scripts\/fixtures\/tooling\/nodex\/profile-settings-)/u;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep Profile settings bound to the explicit bootstrap authority instead of process globals.",
    },
  },
  create(context) {
    if (!PROFILE_SETTINGS_FILE_PATTERN.test(context.filename)) return {};
    if (/\/src\/main\/settings\/.*\.test\.[cm]?[jt]sx?$/u.test(context.filename)) return {};

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "node:os" && node.source.value !== "os") return;
        context.report({
          node,
          message:
            "Profile settings must not derive authority from the OS home. Accept an explicit settings path from MainConfig.",
        });
      },
      MemberExpression(node) {
        const object = unwrapExpression(node.object);
        const property = getPropertyName(node.property);
        if (!isIdentifier(object, "process") || (property !== "cwd" && property !== "env")) {
          return;
        }
        context.report({
          node,
          message:
            "Profile settings must not read process.cwd() or process.env. Accept immutable bootstrap inputs from MainConfig.",
        });
      },
    };
  },
});
