import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A space-free directory for node-gyp builds. node-gyp hands source, include and framework paths
 * to `make` as whitespace-separated words, so a build beneath a checkout whose path contains a
 * space (for example a macOS `managed worktrees` folder) fails to compile. Native compilation runs
 * here, and only its finished artifacts are copied back into the checkout.
 */
export function nativeBuildScratchDirectory(checkoutRoot: string): string {
  const digest = createHash("sha256").update(checkoutRoot).digest("hex").slice(0, 16);
  const directory = join(tmpdir(), `nodex-native-${digest}`);
  if (/\s/u.test(directory)) {
    throw new Error(
      `Native builds need a temporary directory without whitespace; ${directory} contains some. Set TMPDIR to a path without spaces.`,
    );
  }
  mkdirSync(directory, { recursive: true });
  return directory;
}
