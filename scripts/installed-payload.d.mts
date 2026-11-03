export interface InstalledPayloadInventory {
  readonly bytes: number;
  readonly fileCount: number;
  readonly files: readonly { readonly path: string; readonly size: number }[];
}
export function installedPayloadInventory(root: string): InstalledPayloadInventory;
