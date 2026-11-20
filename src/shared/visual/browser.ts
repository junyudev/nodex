import { parseSync, visitorKeys } from "oxc-parser";
import { transformSync } from "oxc-transform";
import { createVisualCompiler } from "./compiler";

// Only the Visual compiler worker imports this entry. The WASI bindings initialize at module load.
export const { compileVisual, rewriteVisual } = createVisualCompiler({
  parseSync,
  visitorKeys,
  transformSync,
});
