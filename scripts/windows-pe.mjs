// Shared by TypeScript staging and electron-builder's Node-only afterPack hook.
import { closeSync, lstatSync, openSync, readSync, readdirSync, fstatSync } from "node:fs";
import path from "node:path";
import { isWindowsSystemDll } from "./windows-system-dlls.mjs";
export { isWindowsSystemDll };

import { WINDOWS_PE_MACHINE as machines } from "../src/shared/windows-pe-header.mjs";
export { inspectWindowsPe } from "../src/shared/windows-pe-header.mjs";

/** Inspect the PE signature and COFF Machine, never a filename or emulation result. */
function readPeMachine(file) {
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
    return pe.readUInt16LE(4);
  } finally {
    closeSync(descriptor);
  }
}

/** Read DLL names from both ordinary and delay-load descriptors (PE32 and PE32+).
 * RVAs must map to file-backed section bytes; malformed tables fail closed.
 */
export function readPeImports(file) {
  const descriptor = openSync(file, "r");
  const fileSize = fstatSync(descriptor).size;
  const invalid = (detail) => new Error(`Invalid PE imports (${detail}): ${file}`);
  const read = (position, length) => {
    if (!Number.isSafeInteger(position) || position < 0 || position + length > fileSize)
      throw invalid("truncated image");
    const bytes = Buffer.alloc(length);
    if (readSync(descriptor, bytes, 0, length, position) !== length)
      throw invalid("truncated image");
    return bytes;
  };
  try {
    const dos = read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) throw invalid("DOS signature");
    const peOffset = dos.readUInt32LE(0x3c);
    const coff = read(peOffset, 24);
    if (coff.readUInt32LE(0) !== 0x4550) throw invalid("PE signature");
    const optionalSize = coff.readUInt16LE(20);
    const optional = read(peOffset + 24, optionalSize);
    if (optional.length < 2) throw invalid("missing optional header");
    const magic = optional.readUInt16LE(0);
    if (magic !== 0x10b && magic !== 0x20b) throw invalid("optional header magic");
    const directoriesOffset = magic === 0x20b ? 112 : 96;
    if (optional.length < directoriesOffset) throw invalid("short optional header");
    const directoryCount = optional.readUInt32LE(directoriesOffset - 4);
    if (directoryCount > 16 || directoriesOffset + directoryCount * 8 > optionalSize)
      throw invalid("data directory count");
    const imageBase =
      magic === 0x20b ? optional.readBigUInt64LE(24) : BigInt(optional.readUInt32LE(28));
    const headerSize = optional.readUInt32LE(60);
    const sectionCount = coff.readUInt16LE(6);
    const sections = Array.from({ length: sectionCount }, (_, index) => {
      const section = read(peOffset + 24 + optionalSize + index * 40, 40);
      return {
        rva: section.readUInt32LE(12),
        size: section.readUInt32LE(16),
        offset: section.readUInt32LE(20),
      };
    });
    const offsetFor = (rva, length) => {
      if (!Number.isSafeInteger(rva) || rva <= 0) throw invalid("invalid RVA");
      if (rva < headerSize && rva + length <= headerSize) return rva;
      const section = sections.find(
        (entry) => rva >= entry.rva && rva + length <= entry.rva + entry.size,
      );
      if (!section) throw invalid(`unmapped RVA 0x${rva.toString(16)}`);
      return section.offset + rva - section.rva;
    };
    const readRva = (rva, length) => read(offsetFor(rva, length), length);
    const dllName = (rva) => {
      // Windows import names are short basenames, never paths or unbounded strings.
      const bytes = [];
      for (let index = 0; index < 256; index += 1) {
        const byte = readRva(rva + index, 1)[0];
        if (byte === 0) {
          const name = Buffer.from(bytes).toString("ascii");
          if (!/^[a-z0-9_.-]+\.(?:dll|drv|exe|cpl)$/iu.test(name))
            throw invalid(`DLL basename ${JSON.stringify(name)}`);
          return name;
        }
        if (byte > 127) throw invalid("non-ASCII DLL name");
        bytes.push(byte);
      }
      throw invalid("unterminated DLL name");
    };
    const imports = [];
    for (const [directory, kind, stride, nameOffset] of [
      [1, "import", 20, 12],
      [13, "delay", 32, 4],
    ]) {
      if (directory >= directoryCount) continue;
      const rva = optional.readUInt32LE(directoriesOffset + directory * 8);
      const size = optional.readUInt32LE(directoriesOffset + directory * 8 + 4);
      if (rva === 0 && size === 0) continue;
      if (rva === 0 || size < stride || size > 1024 * 1024) throw invalid(`${kind} directory size`);
      let terminated = false;
      for (let cursor = 0; cursor + stride <= size; cursor += stride) {
        const entry = readRva(rva + cursor, stride);
        if (entry.every((byte) => byte === 0)) {
          terminated = true;
          break;
        }
        let nameRva = entry.readUInt32LE(nameOffset);
        if (kind === "delay") {
          const attributes = entry.readUInt32LE(0);
          if (attributes > 1) throw invalid("delay attributes");
          if (attributes === 0) nameRva = Number(BigInt(nameRva) - imageBase);
        }
        imports.push({ name: dllName(nameRva), kind });
      }
      if (!terminated) throw invalid(`unterminated ${kind} table`);
    }
    return imports;
  } finally {
    closeSync(descriptor);
  }
}

/** Require OS imports or a same-directory, matching-CPU app-local dependency.
 * No PATH, System32, sibling directories, or runner-installed runtimes participate.
 */
export function assertPeDependencies(file, expected, options = {}) {
  const directory = path.dirname(file);
  const siblings = new Map(readdirSync(directory).map((name) => [name.toLowerCase(), name]));
  for (const { name, kind } of readPeImports(file)) {
    if (isWindowsSystemDll(name)) continue;
    if (options.systemOnly === true)
      throw new Error(`Nodex native image requires a non-OS ${kind} dependency ${name}: ${file}`);
    // node-gyp's delay-load hook binds Node's exports to the already-loaded host.
    // This is an EXE import, not a redistributable DLL or a DLL-search exemption.
    if (
      kind === "delay" &&
      name.toLowerCase() === "node.exe" &&
      /\.node$/iu.test(file) &&
      options.nodeHost
    ) {
      const host = lstatSync(options.nodeHost);
      if (!host.isFile() || host.isSymbolicLink())
        throw new Error(`Node addon host is not a regular file: ${options.nodeHost}`);
      assertPeArchitecture(options.nodeHost, expected);
      continue;
    }
    // This reviewed addon uses the Electron host's delay-load binding. Its
    // actual load is a worker probe and is independent of app-local DLLs.
    if (
      options.windowsAccountHostProbe === true &&
      kind === "delay" &&
      path.basename(file) === "windows-account.node" &&
      name.toLowerCase() === "chrome.dll"
    )
      continue;
    const sibling = siblings.get(name.toLowerCase());
    if (!sibling)
      throw new Error(
        `Unresolved Windows ${kind} dependency ${name}: ${file}; ship it beside this image (clean Windows cannot use the build host's runtimes)`,
      );
    const dependency = path.join(directory, sibling);
    const stat = lstatSync(dependency);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`App-local Windows dependency is not a regular file: ${dependency}`);
    assertPeArchitecture(dependency, expected);
  }
}

export function readPeArchitecture(file) {
  const machine = readPeMachine(file);
  const architecture = Object.keys(machines).find((key) => machines[key] === machine);
  if (!architecture) throw new Error(`Unsupported PE Machine 0x${machine.toString(16)}: ${file}`);
  return architecture;
}

export function assertPeArchitecture(file, expected) {
  if (!(expected in machines)) throw new Error(`Unsupported Windows architecture: ${expected}`);
  const actual = readPeArchitecture(file);
  if (actual !== expected)
    throw new Error(
      `Windows architecture mismatch: expected ${expected}, found ${actual}: ${file}`,
    );
}

/** Inventory includes renamed PE images, never symlinks or special files. */
export function listWindowsPeImages(root) {
  const files = [];
  const visit = (file) => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Windows payload contains a symbolic link: ${file}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(path.join(file, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`Windows payload contains a special file: ${file}`);
    const descriptor = openSync(file, "r");
    const magic = Buffer.alloc(2);
    try {
      readSync(descriptor, magic, 0, 2, 0);
    } finally {
      closeSync(descriptor);
    }
    if (/\.(?:exe|dll|node)$/iu.test(file) || magic.readUInt16LE(0) === 0x5a4d)
      files.push(path.relative(root, file).split(path.sep).join("/"));
  };
  visit(root);
  return files;
}

/** Every shipped PE must match its CPU and have a clean-machine dependency closure. */
export function verifyWindowsArchitectureClosure(root, expected, options = {}) {
  if (!(expected in machines)) throw new Error(`Unsupported Windows architecture: ${expected}`);
  const files = listWindowsPeImages(root);
  if (!files.length) throw new Error(`Windows payload has no native images: ${root}`);
  return files.filter((relative) => {
    const file = path.join(root, relative);
    // NSIS adds only this maintenance bootstrap after the payload is sealed.
    if (options.installed === true && relative.toLowerCase() === "uninstall nodex.exe") {
      const machine = readPeMachine(file);
      if (machine !== 0x14c && machine !== machines[expected])
        throw new Error(`Unexpected NSIS uninstaller machine: 0x${machine.toString(16)}: ${file}`);
      assertPeDependencies(file, expected, { systemOnly: true });
      return false;
    }
    assertPeArchitecture(file, expected);
    const desktopToolPath = options.desktopToolsRoot
      ? path.relative(options.desktopToolsRoot, file).split(path.sep).join("/")
      : null;
    const isDesktopTool =
      desktopToolPath !== null &&
      !path.isAbsolute(desktopToolPath) &&
      desktopToolPath !== ".." &&
      !desktopToolPath.startsWith("../");
    assertPeDependencies(file, expected, {
      nodeHost: isDesktopTool
        ? path.join(options.desktopToolsRoot, "bin/node.exe")
        : options.nodeHost,
      windowsAccountHostProbe: isDesktopTool && desktopToolPath === "native/windows-account.node",
      systemOnly: /(?:^|\/)bin\/nodex(?:-core)?\.exe$/iu.test(relative),
    });
    return true;
  });
}
