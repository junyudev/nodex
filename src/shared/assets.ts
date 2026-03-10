export const NODEX_ASSET_SCHEME = "nodex://assets/";

const SAFE_FILE_NAME_REGEX = /^[A-Za-z0-9._-]+$/;

export interface ParsedAssetSource {
  fileName: string;
}

export function isSafeAssetFileName(fileName: string): boolean {
  return SAFE_FILE_NAME_REGEX.test(fileName);
}

export function getAssetSource(fileName: string): string {
  if (!isSafeAssetFileName(fileName)) {
    throw new Error("Invalid file name");
  }

  return `${NODEX_ASSET_SCHEME}${encodeURIComponent(fileName)}`;
}

export function parseAssetSource(source: string): ParsedAssetSource | null {
  if (!source.startsWith(NODEX_ASSET_SCHEME)) return null;

  const remainder = source.slice(NODEX_ASSET_SCHEME.length);
  if (!remainder || remainder.includes("/")) return null;

  try {
    const fileName = decodeURIComponent(remainder);
    if (!isSafeAssetFileName(fileName)) return null;

    return { fileName };
  } catch {
    return null;
  }
}
