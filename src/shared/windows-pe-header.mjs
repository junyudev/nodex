import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Inspect an image without loading it. A certificate table is only structural evidence. */
export function inspectWindowsPe(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (offset, length) => {
      if (offset + length > size) throw new Error(`Truncated PE image: ${file}`);
      const bytes = Buffer.alloc(length);
      if (readSync(fd, bytes, 0, length, offset) !== length) {
        throw new Error(`Truncated PE image: ${file}`);
      }
      return bytes;
    };
    if (size < 2 || read(0, 2).readUInt16LE() !== 0x5a4d) return null;
    const peOffset = read(0x3c, 4).readUInt32LE();
    const coff = read(peOffset, 24);
    if (coff.readUInt32LE() !== 0x4550) throw new Error(`Invalid PE signature: ${file}`);
    const machine = coff.readUInt16LE(4);
    const optional = read(peOffset + 24, coff.readUInt16LE(20));
    const magic = optional.length >= 2 ? optional.readUInt16LE() : 0;
    const directory = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
    if (!directory) throw new Error(`Invalid PE optional header: ${file}`);
    const security = directory + 4 * 8;
    if (optional.length < directory || optional.readUInt32LE(directory - 4) <= 4) {
      return { machine, certificate: null };
    }
    if (optional.length < security + 8) throw new Error(`Truncated PE directory: ${file}`);
    const offset = optional.readUInt32LE(security);
    const length = optional.readUInt32LE(security + 4);
    if (offset === 0 && length === 0) return { machine, certificate: null };
    if (
      offset < peOffset + 24 + optional.length ||
      offset % 8 !== 0 ||
      length < 8 ||
      length > 1024 * 1024 ||
      offset + length > size
    ) {
      throw new Error(`Invalid PE certificate table: ${file}`);
    }
    const header = read(offset, 8);
    const certificateLength = header.readUInt32LE();
    if (
      certificateLength <= 8 ||
      certificateLength > length ||
      header.readUInt16LE(4) !== 0x200 ||
      header.readUInt16LE(6) !== 2
    ) {
      throw new Error(`Invalid embedded PE certificate: ${file}`);
    }
    return { machine, certificate: read(offset + 8, certificateLength - 8) };
  } finally {
    closeSync(fd);
  }
}

export const WINDOWS_PE_MACHINE = Object.freeze({ x64: 0x8664, arm64: 0xaa64 });
