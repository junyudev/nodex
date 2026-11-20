export interface InstalledPayloadInventory {
  readonly bytes: number;
  readonly fileCount: number;
  readonly files: readonly { readonly path: string; readonly size: number }[];
}
export function installedPayloadInventory(
  root: string,
  options?: { readonly skipSymlinks?: boolean },
): InstalledPayloadInventory;
export function assertMacInstalledPayloadBudget(appPath: string): InstalledPayloadInventory;
export function assertMacDocumentToolsDetached(resourcesPath: string): void;
