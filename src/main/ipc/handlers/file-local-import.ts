import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import {
  FILE_IMPORT_MAX_BYTES,
  FILE_IMPORT_MAX_COUNT,
  FILE_MAX_BYTES,
} from "../../../shared/file-resources";

export interface LocalFileCandidate {
  readonly filePath: string;
  readonly logicalPath: string;
  readonly byteLength: number;
}

/**
 * Reads exactly one opened regular file object with bounded memory.
 * Opening with O_NOFOLLOW and validating through the handle closes the path
 * replacement window between metadata validation and byte access.
 */
export async function readLocalFile(filePath: string): Promise<Uint8Array> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile()) throw new Error("Files only accept regular files");
    if (initial.size > BigInt(FILE_MAX_BYTES)) {
      throw new Error("File exceeds the 64 MiB limit");
    }

    const expectedByteLength = Number(initial.size);
    const bytes = Buffer.allocUnsafe(expectedByteLength + 1);
    let byteLength = 0;
    while (byteLength < bytes.byteLength) {
      const result = await handle.read(bytes, byteLength, bytes.byteLength - byteLength, null);
      if (result.bytesRead === 0) break;
      byteLength += result.bytesRead;
    }

    const final = await handle.stat({ bigint: true });
    const changedDuringRead =
      byteLength !== expectedByteLength ||
      final.size !== initial.size ||
      final.mtimeNs !== initial.mtimeNs ||
      final.ctimeNs !== initial.ctimeNs;
    if (changedDuringRead) throw new Error("File changed while it was being read");
    return bytes.subarray(0, byteLength);
  } finally {
    await handle.close();
  }
}

/**
 * Expands one native selection into a deterministic, bounded File batch.
 * Folder identity remains a logical-path prefix; only regular files become candidates.
 */
export async function collectLocalFileCandidates(
  selectedPaths: readonly string[],
): Promise<readonly LocalFileCandidate[]> {
  if (selectedPaths.length > FILE_IMPORT_MAX_COUNT) {
    throw new Error("File import exceeds the 100 File batch limit");
  }

  const candidates: LocalFileCandidate[] = [];
  const uniqueRoots = new Set<string>();
  let totalBytes = 0;

  const addFile = async (filePath: string, logicalPath: string): Promise<void> => {
    const metadata = await fs.lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${logicalPath} is not a regular file`);
    }
    if (metadata.size > FILE_MAX_BYTES) {
      throw new Error(`${logicalPath} exceeds the 64 MiB File limit`);
    }

    totalBytes += metadata.size;
    if (totalBytes > FILE_IMPORT_MAX_BYTES) {
      throw new Error("File import exceeds the 256 MiB batch limit");
    }
    candidates.push({ filePath, logicalPath, byteLength: metadata.size });
    if (candidates.length > FILE_IMPORT_MAX_COUNT) {
      throw new Error("File import exceeds the 100 File batch limit");
    }
  };

  const visitDirectory = async (directoryPath: string, logicalPath: string): Promise<void> => {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      const entryLogicalPath = `${logicalPath}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`${entryLogicalPath} is a symbolic link`);
      }
      if (entry.isDirectory()) {
        await visitDirectory(entryPath, entryLogicalPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`${entryLogicalPath} is not a regular file or folder`);
      }
      await addFile(entryPath, entryLogicalPath);
    }
  };

  for (const selectedPath of selectedPaths) {
    if (!selectedPath || selectedPath !== selectedPath.trim() || !path.isAbsolute(selectedPath)) {
      throw new Error("File import requires absolute local paths");
    }
    const rootPath = path.resolve(selectedPath);
    if (uniqueRoots.has(rootPath)) continue;
    uniqueRoots.add(rootPath);

    const rootName = path.basename(rootPath);
    if (!rootName) throw new Error("File import root has no portable name");
    const metadata = await fs.lstat(rootPath);
    if (metadata.isSymbolicLink()) throw new Error(`${rootName} is a symbolic link`);
    if (metadata.isDirectory()) {
      await visitDirectory(rootPath, rootName);
      continue;
    }
    if (metadata.isFile()) {
      await addFile(rootPath, rootName);
      continue;
    }
    throw new Error(`${rootName} is not a regular file or folder`);
  }

  return candidates;
}
