import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { appToolCatalog } from "./catalog";

export type AppToolCatalogPurpose = "session" | "automation" | "system";

/** Tool visibility is separate from the verified Turn authority checked at execution. */
export function selectAppToolCatalog(input: {
  readonly nativeMcp: boolean;
  readonly purpose: AppToolCatalogPurpose;
}): readonly Tool[] {
  if (!input.nativeMcp || input.purpose === "system") return [];
  return appToolCatalog;
}
