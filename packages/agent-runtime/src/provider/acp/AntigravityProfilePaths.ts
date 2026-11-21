// @effect-diagnostics nodeBuiltinImport:off -- lstat proves no managed component is a link.
import { constants, type Stats } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Proves a native runtime entry is at its literal path below the canonical profile: every
 * component exists with the expected type and none is a link. A link could point at another
 * child's transcript or another session's database under the same profile.
 */
export async function antigravityManagedPath(
  profileRoot: string,
  segments: ReadonlyArray<string>,
  kind: "file" | "directory",
): Promise<{ readonly path: string; readonly info: Stats } | undefined> {
  let current = profileRoot;
  let info: Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = NodePath.join(current, segment);
    info = await NodeFSP.lstat(current).catch(() => undefined);
    const expectFile = kind === "file" && index === segments.length - 1;
    if (
      info === undefined ||
      info.isSymbolicLink() ||
      (expectFile ? !info.isFile() : !info.isDirectory())
    ) {
      return undefined;
    }
  }
  if (info === undefined) return undefined;
  return (await NodeFSP.realpath(current).catch(() => undefined)) === current
    ? { path: current, info }
    : undefined;
}

export async function antigravityProfileRoot(profileDirectory: string) {
  const info = await NodeFSP.lstat(profileDirectory).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;
  return NodeFSP.realpath(profileDirectory).catch(() => undefined);
}

/** Read at most the proven file size plus one byte, including after a concurrent append. */
export async function readAntigravityManagedText(
  file: { readonly path: string; readonly info: Stats },
  maxBytes: number,
) {
  if (file.info.size > maxBytes) throw new Error("Antigravity file exceeded its read limit.");
  const handle = await NodeFSP.open(
    file.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.ino !== file.info.ino ||
      info.dev !== file.info.dev ||
      info.size > maxBytes
    ) {
      throw new Error("Antigravity file changed before it could be read.");
    }
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error("Antigravity file changed while being read.");
    return { text: buffer.toString("utf8", 0, length), bytes: length };
  } finally {
    await handle.close();
  }
}
