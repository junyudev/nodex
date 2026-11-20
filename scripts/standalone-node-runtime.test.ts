import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { desktopBuildTarget } from "./desktop-build-target";
import { assertStandaloneNodeRuntime, stageStandaloneNodeRuntime } from "./standalone-node-runtime";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

test.skipIf(process.platform !== "darwin").each([
  { fixture: "arm64", failure: null },
  { fixture: "x64", failure: "Expected an executable arm64 Mach-O" },
  { fixture: "symlink", failure: "Expected exactly one regular bin/node" },
])(
  "stages only the locked regular arm64 executable from a $fixture archive",
  async ({ fixture, failure }) => {
    const root = mkdtempSync(join(tmpdir(), "nodex-standalone-node-"));
    vi.stubEnv("NODEX_BUILD_CACHE_DIR", join(root, "cache"));
    try {
      const target = desktopBuildTarget("darwin", "arm64");
      const version = "24.22.1";
      const releaseDirectory = `node-v${version}-darwin-arm64`;
      const binary = Buffer.alloc(32);
      binary.writeUInt32LE(0xfeedfacf, 0);
      binary.writeUInt32LE(fixture === "x64" ? 0x01000007 : 0x0100000c, 4);
      binary.writeUInt32LE(2, 12); // MH_EXECUTE
      const archiveRoot = join(root, releaseDirectory);
      const node = join(archiveRoot, "bin/node");
      mkdirSync(dirname(node), { recursive: true });
      writeFileSync(join(archiveRoot, "ignored"), binary);
      if (fixture === "symlink") symlinkSync("../ignored", node);
      else writeFileSync(node, binary);
      const archivePath = join(root, `${releaseDirectory}.tar.gz`);
      execFileSync("/usr/bin/tar", ["-czf", archivePath, "-C", root, releaseDirectory]);
      const archive = readFileSync(archivePath);
      const archiveIdentity = {
        name: `${releaseDirectory}.tar.gz`,
        sha256: sha256(archive),
        size: archive.length,
      };
      const cached = join(root, "cache/node-runtime", archiveIdentity.sha256, archiveIdentity.name);
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, archive);
      const license = join(root, "resources/third-party/node/LICENSE");
      mkdirSync(dirname(license), { recursive: true });
      writeFileSync(license, "locked license");
      const lock = join(root, "resources/agent-runtime/node-runtime.lock.json");
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(
        lock,
        JSON.stringify({
          schemaVersion: 1,
          version,
          licenseSha256: sha256("locked license"),
          builds: {
            "darwin-arm64": {
              sha256: sha256(binary),
              size: binary.length,
              archive: archiveIdentity,
            },
          },
        }),
      );

      const stage = stageStandaloneNodeRuntime(root, target);
      if (failure) {
        await expect(stage).rejects.toThrow(failure);
        return;
      }

      await stage;
      const resolved = assertStandaloneNodeRuntime(root, target);
      expect(resolved.version).toBe(version);
      expect(readdirSync(dirname(resolved.executable)).sort()).toEqual([
        "LICENSE",
        "node",
        "node-runtime.json",
      ]);
      expect(readFileSync(resolved.executable)).toEqual(binary);
      writeFileSync(resolved.executable, "changed");
      expect(() => assertStandaloneNodeRuntime(root, target)).toThrow("checksum mismatch");
      await stageStandaloneNodeRuntime(root, target);
      expect(readFileSync(resolved.executable)).toEqual(binary);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
