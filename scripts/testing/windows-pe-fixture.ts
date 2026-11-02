/** Minimal file-backed PE image with real import and delay-load directories. */
export function windowsPeFixture(
  machine: number,
  imports: readonly string[] = [],
  delayImports: readonly string[] = [],
  options: { readonly pe32?: boolean; readonly delayVirtualAddresses?: boolean } = {},
): Buffer {
  const bytes = Buffer.alloc(4096);
  const pe = 128;
  const optional = pe + 24;
  const optionalSize = options.pe32 ? 224 : 240;
  const directories = optional + (options.pe32 ? 96 : 112);
  bytes.writeUInt16LE(0x5a4d);
  bytes.writeUInt32LE(pe, 0x3c);
  bytes.writeUInt32LE(0x4550, pe);
  bytes.writeUInt16LE(machine, pe + 4);
  bytes.writeUInt16LE(1, pe + 6);
  bytes.writeUInt16LE(optionalSize, pe + 20);
  bytes.writeUInt16LE(options.pe32 ? 0x10b : 0x20b, optional);
  const imageBase = 0x400000;
  if (options.pe32) bytes.writeUInt32LE(imageBase, optional + 28);
  else bytes.writeBigUInt64LE(BigInt(imageBase), optional + 24);
  bytes.writeUInt32LE(512, optional + 60);
  bytes.writeUInt32LE(16, directories - 4);
  const section = optional + optionalSize;
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(bytes.length - 512, section + 16);
  bytes.writeUInt32LE(512, section + 20);
  let nextName = 2048;
  for (const [index, names, table, stride, nameOffset] of [
    [1, imports, 512, 20, 12],
    [13, delayImports, 1024, 32, 4],
  ] as const) {
    if (!names.length) continue;
    bytes.writeUInt32LE(table - 512 + 0x1000, directories + index * 8);
    bytes.writeUInt32LE((names.length + 1) * stride, directories + index * 8 + 4);
    for (const [ordinal, name] of names.entries()) {
      const entry = table + ordinal * stride;
      const useVa = index === 13 && options.delayVirtualAddresses;
      if (index === 13) bytes.writeUInt32LE(useVa ? 0 : 1, entry);
      bytes.writeUInt32LE(nextName - 512 + 0x1000 + (useVa ? imageBase : 0), entry + nameOffset);
      nextName += bytes.write(`${name}\0`, nextName, "ascii");
    }
  }
  return bytes;
}
