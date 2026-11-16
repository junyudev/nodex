import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { initSearchKernelSync } from "@nodex/search-kernel";

// Vitest's renderer transform serves asset URLs. Node and jsdom tests initialize from disk.
const requireFromRoot = createRequire(resolve("package.json"));
initSearchKernelSync(readFileSync(requireFromRoot.resolve("@nodex/search-kernel/wasm")));
