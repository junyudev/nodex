import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";

import { createSparkleArchive, extractSparkleArchive } from "./sparkle-archive";
import { immutableDirectoryDigest } from "../immutable-artifact-cache";

test.skipIf(process.platform !== "darwin")(
  "round-trips app bytes, executable modes and framework symlinks in a deterministic tar.xz",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "sparkle-archive-"));
    try {
      const app = path.join(root, "Small App.app");
      const resources = path.join(app, "Contents/Resources");
      const executable = path.join(app, "Contents/MacOS/app");
      mkdirSync(resources, { recursive: true });
      mkdirSync(path.dirname(executable));
      writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      chmodSync(executable, 0o751);
      writeFileSync(path.join(resources, "z-last"), "last");
      writeFileSync(path.join(resources, "a\nfirst"), Buffer.from([0, 1, 2, 255]));
      writeFileSync(path.join(resources, "._metadata"), "AppleDouble");
      symlinkSync("Resources", path.join(app, "Contents/Current"));
      // Resource-fork metadata must not create AppleDouble entries either.
      execFileSync("/usr/bin/xattr", ["-w", "com.apple.test", "metadata", executable]);
      const archive = path.join(root, "update.tar.xz");
      const second = path.join(root, "repeat.tar.xz");
      createSparkleArchive(app, archive);
      createSparkleArchive(app, second);
      expect(readFileSync(second)).toEqual(readFileSync(archive));
      const extracted = extractSparkleArchive(archive, path.join(root, "extracted"));
      expect(readFileSync(path.join(extracted, "Contents/MacOS/app"))).toEqual(
        readFileSync(executable),
      );
      expect(lstatSync(path.join(extracted, "Contents/MacOS/app")).mode & 0o777).toBe(0o751);
      expect(readlinkSync(path.join(extracted, "Contents/Current"))).toBe("Resources");
      expect(readFileSync(path.join(extracted, "Contents/Resources/a\nfirst"))).toEqual(
        Buffer.from([0, 1, 2, 255]),
      );
      rmSync(path.join(resources, "._metadata"));
      expect(immutableDirectoryDigest(extracted)).toBe(immutableDirectoryDigest(app));
      expect(
        execFileSync("/usr/bin/tar", ["-tf", archive], { encoding: "utf8" }).trim().split("\n"),
      ).toEqual([
        "Small App.app/",
        "Small App.app/Contents/",
        "Small App.app/Contents/Current",
        "Small App.app/Contents/MacOS/",
        "Small App.app/Contents/MacOS/app",
        "Small App.app/Contents/Resources/",
        "Small App.app/Contents/Resources/a\\nfirst",
        "Small App.app/Contents/Resources/z-last",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")("reads a published ZIP through the same reader", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sparkle-zip-history-"));
  try {
    const app = path.join(root, "Old.app");
    mkdirSync(app);
    writeFileSync(path.join(app, "payload"), "published ZIP bytes");
    symlinkSync("payload", path.join(app, "link"));
    const archive = path.join(root, "old.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive]);
    const extracted = extractSparkleArchive(archive, path.join(root, "extracted"));
    expect(readFileSync(path.join(extracted, "payload"), "utf8")).toBe("published ZIP bytes");
    expect(readlinkSync(path.join(extracted, "link"))).toBe("payload");
    expect(() => extractSparkleArchive(path.join(root, "old.aar"), root)).toThrow("Unsupported");
    expect(() => createSparkleArchive(app, archive)).toThrow("must use tar.xz");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
