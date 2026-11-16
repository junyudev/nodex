import { URL } from "node:url";

// Source and the standalone Runtime read the same asset relative to this module.
export default new URL("./generated/nodex_search_kernel_bg.wasm", import.meta.url);
