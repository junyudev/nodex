export const COPY_FILE_REFERENCES_AS_LOCAL_PATHS_STORAGE_KEY =
  "nodex-copy-file-references-as-local-paths-v1";

export function readCopyFileReferencesAsLocalPaths(): boolean {
  try {
    return localStorage.getItem(COPY_FILE_REFERENCES_AS_LOCAL_PATHS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeCopyFileReferencesAsLocalPaths(enabled: boolean): boolean {
  try {
    localStorage.setItem(COPY_FILE_REFERENCES_AS_LOCAL_PATHS_STORAGE_KEY, String(enabled));
  } catch {
    // localStorage may be unavailable.
  }
  return enabled;
}
