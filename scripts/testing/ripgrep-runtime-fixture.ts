import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertRipgrepBytes,
  ripgrepMachOContentSha256,
  ripgrepSha256,
} from "../../src/main/platform/node/ripgrep-runtime-artifact.mjs";
import {
  ripgrepExecutableName,
  ripgrepRelease,
  type RipgrepTarget,
} from "../../src/shared/ripgrep-runtime-metadata.mjs";

export function ripgrepFixture(target: RipgrepTarget) {
  const binary = Buffer.alloc(256);
  const mac = target === "darwin-arm64";
  if (mac) {
    binary.writeUInt32LE(0xfeedfacf, 0);
    binary.writeUInt32LE(0x100000c, 4);
    binary.writeUInt32LE(2, 16);
    binary.writeUInt32LE(88, 20);
    binary.writeUInt32LE(0x19, 32);
    binary.writeUInt32LE(72, 36);
    binary.write("__LINKEDIT", 40);
    binary.writeBigUInt64LE(4096n, 64);
    binary.writeBigUInt64LE(128n, 72);
    binary.writeBigUInt64LE(128n, 80);
    binary.writeUInt32LE(0x1d, 104);
    binary.writeUInt32LE(16, 108);
    binary.writeUInt32LE(224, 112);
    binary.writeUInt32LE(32, 116);
  } else {
    binary.write("MZ", 0);
    binary.writeUInt32LE(64, 60);
    binary.writeUInt32LE(0x4550, 64);
    binary.writeUInt16LE(0x8664, 68);
  }
  const license = "Fixture license\n";
  const release = {
    ...ripgrepRelease,
    licenseSha256: ripgrepSha256(Buffer.from(license)),
    builds: {
      ...ripgrepRelease.builds,
      [target]: {
        ...ripgrepRelease.builds[target],
        binarySize: binary.length,
        binarySha256: ripgrepSha256(binary),
        ...(mac ? { machOContentSha256: ripgrepMachOContentSha256(binary) } : {}),
      },
    },
  };
  assertRipgrepBytes(binary, target, "upstream", release);
  return { binary, license, release };
}

export function writeRipgrepFixture(resources: string, target: RipgrepTarget): string {
  const { binary, license } = ripgrepFixture(target);
  const directory = join(resources, "ripgrep-runtime");
  mkdirSync(directory);
  const executable = join(directory, ripgrepExecutableName(target));
  writeFileSync(executable, binary);
  chmodSync(executable, 0o755);
  writeFileSync(join(directory, "LICENSE"), license);
  return executable;
}
