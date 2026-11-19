import { parseSync, visitorKeys } from "oxc-parser";
import { transformSync } from "oxc-transform";
import { createVisualCompiler } from "./compiler";

export const { compileVisual, rewriteVisual } = createVisualCompiler({
  parseSync,
  visitorKeys,
  transformSync,
});
