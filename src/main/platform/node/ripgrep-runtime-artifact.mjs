import { createHash } from "node:crypto";
import { ripgrepRelease } from "../../../shared/ripgrep-runtime-metadata.mjs";

export const ripgrepSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// codesign replaces the terminal signature blob and updates its size and __LINKEDIT's
// sizes. The original signature offset and all other Mach-O bytes stay pinned.
export function ripgrepMachOContentSha256(binary) {
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf)
    throw new Error("Expected a thin 64-bit Mach-O ripgrep executable");
  const commands = binary.readUInt32LE(16);
  const headerEnd = 32 + binary.readUInt32LE(20);
  let signature = -1;
  let linkedit = -1;
  let offset = 32;
  for (let index = 0; index < commands; index++) {
    if (offset + 8 > headerEnd || offset + 8 > binary.length)
      throw new Error("Invalid ripgrep Mach-O load commands");
    const type = binary.readUInt32LE(offset);
    const size = binary.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > headerEnd || offset + size > binary.length)
      throw new Error("Invalid ripgrep Mach-O load command size");
    if (type === 0x1d && size === 16 && signature === -1) signature = offset;
    if (
      type === 0x19 &&
      size === 72 &&
      linkedit === -1 &&
      binary.toString("ascii", offset + 8, offset + 24) === "__LINKEDIT\0\0\0\0\0\0"
    )
      linkedit = offset;
    offset += size;
  }
  if (offset !== headerEnd || signature === -1 || linkedit === -1)
    throw new Error("Missing ripgrep Mach-O signature or linkedit segment");

  const start = binary.readUInt32LE(signature + 8);
  const size = binary.readUInt32LE(signature + 12);
  const fileOffset = binary.readBigUInt64LE(linkedit + 40);
  const fileSize = binary.readBigUInt64LE(linkedit + 48);
  const vmSize = binary.readBigUInt64LE(linkedit + 32);
  if (
    start < headerEnd ||
    size === 0 ||
    start + size !== binary.length ||
    fileOffset > BigInt(start) ||
    fileOffset + fileSize !== BigInt(binary.length) ||
    vmSize < fileSize ||
    vmSize > fileSize + 65_536n
  )
    throw new Error("Invalid ripgrep Mach-O signature layout");

  const header = Buffer.from(binary.subarray(0, headerEnd));
  header.fill(0, linkedit + 32, linkedit + 40);
  header.fill(0, linkedit + 48, linkedit + 56);
  header.fill(0, signature + 12, signature + 16);
  return createHash("sha256")
    .update(header)
    .update(binary.subarray(headerEnd, start))
    .digest("hex");
}

export function assertRipgrepBytes(binary, target, mode = "upstream", release = ripgrepRelease) {
  const build = release.builds[target];
  if (mode === "signed" && target === "darwin-arm64") {
    if (ripgrepMachOContentSha256(binary) === build.machOContentSha256) return;
  } else if (binary.length === build.binarySize && ripgrepSha256(binary) === build.binarySha256) {
    return;
  }
  throw new Error("Standalone ripgrep executable differs from its release lock");
}
