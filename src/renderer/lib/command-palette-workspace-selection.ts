import type { FileSearchScope } from "../../shared/file-search";

/** Choosing a directory is an explicit boundary even when it equals the Project's roots. */
export type CommandPaletteWorkspaceSelection =
  | { readonly kind: "context" }
  | { readonly kind: "directory"; readonly scope: FileSearchScope };

export const COMMAND_PALETTE_CONTEXT_SELECTION = { kind: "context" } as const;

export function commandPaletteWorkspaceScope(
  selection: CommandPaletteWorkspaceSelection,
  context: FileSearchScope | null,
): FileSearchScope | null {
  return selection.kind === "directory" ? selection.scope : context;
}
