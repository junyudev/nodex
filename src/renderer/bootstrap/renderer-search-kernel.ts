import { initSearchKernel } from "@nodex/search-kernel";
import wasmUrl from "@nodex/search-kernel/wasm?url&no-inline";

let ready: Promise<void> | undefined;

export function initializeRendererSearchKernel(): Promise<void> {
  return (ready ??= initSearchKernel(wasmUrl).then(() => undefined));
}
