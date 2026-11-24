import { readFileSync } from "node:fs";
import asset from "#search-kernel-asset";
import type { SearchTextQuery } from "./generated/nodex_search_kernel.js";
import { initSearchKernelSync } from "./wasm.ts";

let kernel: ReturnType<typeof initSearchKernelSync> | undefined;

export function searchKernel(): ReturnType<typeof initSearchKernelSync> {
  return (kernel ??= initSearchKernelSync(readFileSync(asset)));
}

export function compileSearchQuery(query: string): SearchTextQuery {
  return new (searchKernel().SearchTextQuery)(query);
}

export type {
  FileNameIndex,
  FileNameSearch,
  SearchTextQuery,
} from "./generated/nodex_search_kernel.js";
