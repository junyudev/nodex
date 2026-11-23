import searchWasm from "../crates/nodex-search-kernel/generated/nodex_search_kernel_bg.wasm?url&inline";
import { initSearchKernelSync } from "../crates/nodex-search-kernel/wasm";

// The Vite import records the WASM bytes as a dependency in both test environments.
initSearchKernelSync(Buffer.from(searchWasm.slice(searchWasm.indexOf(",") + 1), "base64"));
