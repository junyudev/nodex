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
import {
  assertRipgrepBytes,
  ripgrepSha256,
} from "../src/main/platform/node/ripgrep-runtime-artifact.mjs";
import {
  parseRipgrepRelease,
  ripgrepRelease,
  ripgrepTarget,
} from "../src/shared/ripgrep-runtime-metadata.mjs";
import { assertRipgrepRuntimePayload } from "./ripgrep-runtime-payload.mjs";
import { stageStandaloneRipgrepRuntime } from "./standalone-ripgrep-runtime";
import { ripgrepFixture } from "./testing/ripgrep-runtime-fixture";

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

test("the desktop and SSH targets share one validated release and license", () => {
  expect(ripgrepTarget("linux", "x64")).toBe("linux-x64");
  expect(ripgrepRelease.licenseSha256).toBe(
    ripgrepSha256(readFileSync("resources/ripgrep/LICENSE")),
  );
  const invalid = structuredClone(ripgrepRelease);
  expect(() =>
    parseRipgrepRelease({
      ...invalid,
      builds: {
        ...invalid.builds,
        "win32-x64": {
          ...invalid.builds["win32-x64"],
          archive: { ...invalid.builds["win32-x64"].archive, url: "https://example.net/rg.zip" },
        },
      },
    }),
  ).toThrow("win32-x64");
});

test("verifies a replaced signature and rejects changed Mach-O bytes", () => {
  const { release, binary } = ripgrepFixture("darwin-arm64");
  const signed = Buffer.concat([binary, Buffer.alloc(16)]);
  signed.writeUInt32LE(48, 116);
  signed.writeBigUInt64LE(144n, 80);
  expect(() => assertRipgrepBytes(signed, "darwin-arm64", "signed", release)).not.toThrow();
  signed[180] = 1;
  expect(() => assertRipgrepBytes(signed, "darwin-arm64", "signed", release)).toThrow(
    "release lock",
  );
});

test.skipIf(process.platform !== "darwin")(
  "stages the exact pinned member and repairs a tampered executable",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "nodex-ripgrep-stage-"));
    const cache = join(root, "cache");
    vi.stubEnv("NODEX_BUILD_CACHE_DIR", cache);
    try {
      const target = desktopBuildTarget("darwin", "arm64");
      const { binary, license, release } = ripgrepFixture(target.key);
      const { archive } = release.builds[target.key];
      const member = join(root, archive.member);
      const licensePath = join(root, "resources/ripgrep/LICENSE");
      mkdirSync(dirname(member), { recursive: true });
      mkdirSync(dirname(licensePath), { recursive: true });
      writeFileSync(member, binary);
      writeFileSync(licensePath, license);
      const filename = archive.url.split("/").at(-1)!;
      const tarball = join(root, filename);
      execFileSync("/usr/bin/tar", ["-czf", tarball, "-C", root, archive.member]);
      const bytes = readFileSync(tarball);
      const locked = { ...archive, size: bytes.length, sha256: ripgrepSha256(bytes) };
      const cached = join(cache, "ripgrep-runtime", locked.sha256, filename);
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, bytes);
      const fixtureRelease = {
        ...release,
        builds: {
          ...release.builds,
          [target.key]: { ...release.builds[target.key], archive: locked },
        },
      };
      const output = join(root, ".generated/ripgrep-runtime/darwin-arm64");
      await stageStandaloneRipgrepRuntime(root, target, fixtureRelease);
      const executable = assertRipgrepRuntimePayload(output, target.key, {
        release: fixtureRelease,
      });
      expect(readFileSync(executable)).toEqual(binary);
      writeFileSync(executable, Buffer.alloc(binary.length));
      expect(() =>
        assertRipgrepRuntimePayload(output, target.key, { release: fixtureRelease }),
      ).toThrow("release lock");
      await stageStandaloneRipgrepRuntime(root, target, fixtureRelease);
      expect(readFileSync(executable)).toEqual(binary);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
