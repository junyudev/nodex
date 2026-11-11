import { defineRule } from "@oxlint/plugins";

const INTRINSIC_ELEMENT_PATTERN = /^[a-z]/u;
const TITLE_IS_AN_ACCESSIBLE_NAME = new Set(["embed", "frame", "iframe", "math", "object"]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Keep product tooltips on the app-owned accessible tooltip surface.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        if (!INTRINSIC_ELEMENT_PATTERN.test(node.name.name)) return;
        if (TITLE_IS_AN_ACCESSIBLE_NAME.has(node.name.name)) return;

        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute") continue;
          if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "title") continue;

          context.report({
            node: attribute,
            message:
              "Do not use the native title attribute as a tooltip. Wrap the trigger with NodexTooltip from @/components/ui/tooltip.",
          });
        }
      },
    };
  },
});
