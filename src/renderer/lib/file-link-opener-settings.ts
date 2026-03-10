import {
  DEFAULT_FILE_LINK_OPENER_ID,
  normalizeFileLinkOpenerId,
  type FileLinkOpenerId,
} from "../../shared/file-link-openers";

export const FILE_LINK_OPENER_STORAGE_KEY = "nodex-markdown-file-link-opener-v1";

export function readFileLinkOpener(): FileLinkOpenerId {
  try {
    const raw = localStorage.getItem(FILE_LINK_OPENER_STORAGE_KEY);
    return normalizeFileLinkOpenerId(raw);
  } catch {
    return DEFAULT_FILE_LINK_OPENER_ID;
  }
}

export function writeFileLinkOpener(value: FileLinkOpenerId): FileLinkOpenerId {
  const normalized = normalizeFileLinkOpenerId(value);
  try {
    localStorage.setItem(FILE_LINK_OPENER_STORAGE_KEY, normalized);
  } catch {
    // localStorage may be unavailable.
  }
  return normalized;
}
