import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import {
  assertRipgrepBytes,
  ripgrepSha256,
} from "../src/main/platform/node/ripgrep-runtime-artifact.mjs";
import {
  parseRipgrepRelease,
  ripgrepRelease,
  ripgrepTarget,
} from "../src/shared/ripgrep-runtime-metadata.mjs";
import { desktopBuildTarget } from "./desktop-build-target";
import { assertRipgrepRuntimePayload } from "./ripgrep-runtime-payload.mjs";
import { stageStandaloneRipgrepRuntime } from "./standalone-ripgrep-runtime";
import { ripgrepFixture } from "./testing/ripgrep-runtime-fixture";

test("the desktop and SSH targets share one validated release and license", () => {
  expect(ripgrepTarget("win32", "arm64")).toBe("win32-arm64");
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
        "win32-arm64": {
          ...invalid.builds["win32-arm64"],
          archive: { ...invalid.builds["win32-arm64"].archive, url: "https://example.net/rg.zip" },
        },
      },
    }),
  ).toThrow("win32-arm64");
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
