import * as bindings from "./generated/nodex_search_kernel.js";

export function initSearchKernel(input: bindings.InitInput): Promise<bindings.InitOutput> {
  return bindings.default({ module_or_path: input });
}

export function initSearchKernelSync(module: bindings.SyncInitInput): typeof bindings {
  bindings.initSync({ module });
  return bindings;
}

export const searchKernel = bindings;

export type {
  SearchField,
  SearchFieldEvidence,
  SearchMatchQuality,
  SearchTextKind,
  SearchTextMatch,
} from "./generated/nodex_search_kernel.js";
