// Shared by TypeScript staging and electron-builder's Node-only afterPack hook.
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";

const machines = { x64: 0x8664, arm64: 0xaa64 };

/** Inspect the PE signature and COFF Machine, never a filename or emulation result. */
export function readPeArchitecture(file) {
  const descriptor = openSync(file, "r");
  const read = (length, position) => {
    const buffer = Buffer.alloc(length);
    if (readSync(descriptor, buffer, 0, length, position) !== length)
      throw new Error(`Truncated PE header: ${file}`);
    return buffer;
  };
  try {
    const dos = read(64, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error(`Not a Windows PE image: ${file}`);
    const pe = read(24, dos.readUInt32LE(0x3c));
    if (pe.readUInt32LE(0) !== 0x4550) throw new Error(`Invalid PE signature: ${file}`);
    const machine = pe.readUInt16LE(4);
    const architecture = Object.keys(machines).find((key) => machines[key] === machine);
    if (!architecture) throw new Error(`Unsupported PE Machine 0x${machine.toString(16)}: ${file}`);
    return architecture;
  } finally {
    closeSync(descriptor);
  }
}

export function assertPeArchitecture(file, expected) {
  if (!(expected in machines)) throw new Error(`Unsupported Windows architecture: ${expected}`);
  const actual = readPeArchitecture(file);
  if (actual !== expected)
    throw new Error(
      `Windows architecture mismatch: expected ${expected}, found ${actual}: ${file}`,
    );
}

/** Every executable, DLL, and addon in the payload must belong to its target CPU. */
export function verifyWindowsArchitectureClosure(root, expected) {
  const files = [];
  const visit = (file) => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Windows payload contains a symbolic link: ${file}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(path.join(file, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`Windows payload contains a special file: ${file}`);
    if (!/\.(?:exe|dll|node)$/iu.test(file)) return;
    assertPeArchitecture(file, expected);
    files.push(path.relative(root, file).split(path.sep).join("/"));
  };
  visit(root);
  if (!files.length) throw new Error(`Windows payload has no native images: ${root}`);
  return files;
}
