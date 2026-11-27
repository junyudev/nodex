import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeLock from "../resources/agent-runtime/node-runtime.lock.json";
import ripgrepLock from "../resources/ripgrep/ripgrep.lock.json";
import { desktopBuildTarget } from "./desktop-build-target";
import { assertPeArchitecture } from "./windows-pe.mjs";

const [cpu, nodePath, checksumsPath, ripgrepPath] = process.argv.slice(2);
if (!cpu || !nodePath || !checksumsPath || !ripgrepPath) {
  throw new Error(
    "Usage: relock-windows-tools.ts <x64|arm64> <node.exe> <Node SHASUMS256.txt> <ripgrep.zip>",
  );
}
const target = desktopBuildTarget("win32", cpu);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const node = readFileSync(nodePath);
const nodeSha256 = sha256(node);
const nodeMember = `win-${target.arch}/node.exe`;
const officialChecksum = readFileSync(checksumsPath, "utf8")
  .split(/\r?\n/u)
  .find((line) => line.endsWith(`  ${nodeMember}`));
if (officialChecksum !== `${nodeSha256}  ${nodeMember}`) {
  throw new Error(`Node ${nodeLock.version} ${nodeMember} does not match the official checksum`);
}
assertPeArchitecture(nodePath, target.arch);

const ripgrepAsset = `ripgrep-${ripgrepLock.version}-${target.rustTarget}`;
const ripgrepMember = `${ripgrepAsset}/rg.exe`;
const ripgrepArchive = readFileSync(ripgrepPath);
const executable = execFileSync("tar", ["-xOf", ripgrepPath, "--", ripgrepMember], {
  maxBuffer: 16 * 1024 * 1024,
  windowsHide: true,
});
const temporaryRoot = mkdtempSync(join(tmpdir(), "nodex-ripgrep-relock-"));
try {
  const file = join(temporaryRoot, "rg.exe");
  writeFileSync(file, executable);
  assertPeArchitecture(file, target.arch);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

process.stdout.write(
  `${JSON.stringify(
    {
      target: target.key,
      node: { sha256: nodeSha256, size: node.length },
      ripgrep: {
        binarySha256: sha256(executable),
        binarySize: executable.length,
        archive: {
          url: `https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepLock.version}/${ripgrepAsset}.zip`,
          member: ripgrepMember,
          sha256: sha256(ripgrepArchive),
          size: ripgrepArchive.length,
        },
      },
    },
    null,
    2,
  )}\n`,
);
