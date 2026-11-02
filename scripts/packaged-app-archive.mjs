// Keep exported API changes paired with the adjacent .d.mts contract.
import { closeSync, openSync, readSync } from "node:fs";

/** The packed application is Main/renderer output plus its production dependencies. */
export const PACKAGED_APP_ARCHIVE_ENTRIES = Object.freeze(["node_modules", "out", "package.json"]);

const ASAR_PREAMBLE_BYTES = 16;
const MAX_HEADER_BYTES = 256 * 1024 * 1024;

/** Read the top-level names recorded in an asar archive's header. */
export function readAppArchiveTopLevelEntries(archivePath) {
  const descriptor = openSync(archivePath, "r");
  try {
    const preamble = Buffer.alloc(ASAR_PREAMBLE_BYTES);
    if (readSync(descriptor, preamble, 0, ASAR_PREAMBLE_BYTES, 0) !== ASAR_PREAMBLE_BYTES)
      throw new Error(`Packaged app archive is truncated: ${archivePath}`);
    const headerBytes = preamble.readUInt32LE(12);
    if (headerBytes === 0 || headerBytes > MAX_HEADER_BYTES)
      throw new Error(`Packaged app archive has an invalid header: ${archivePath}`);
    const header = Buffer.alloc(headerBytes);
    if (readSync(descriptor, header, 0, headerBytes, ASAR_PREAMBLE_BYTES) !== headerBytes)
      throw new Error(`Packaged app archive header is truncated: ${archivePath}`);
    const files = JSON.parse(header.toString("utf8")).files;
    if (!files || typeof files !== "object")
      throw new Error(`Packaged app archive has no file table: ${archivePath}`);
    return Object.keys(files).sort();
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Refuse an archive that captured workspace content (sources, build trees, caches).
 * A platform `files` list holding only exclusions makes electron-builder pack the whole project.
 */
export function assertPackagedAppArchive(archivePath) {
  const allowed = new Set(PACKAGED_APP_ARCHIVE_ENTRIES);
  const entries = readAppArchiveTopLevelEntries(archivePath);
  const unexpected = entries.filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0)
    throw new Error(
      `Packaged app archive contains files outside the application closure: ${unexpected.join(", ")}`,
    );
  if (!entries.includes("out") || !entries.includes("package.json"))
    throw new Error("Packaged app archive is missing the application output");
  return entries;
}
