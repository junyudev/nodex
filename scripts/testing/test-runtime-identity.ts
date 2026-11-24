import { readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { relativeInput } from "./test-cache-policy.ts";
import { digest, fileStamp, type stampDigests } from "./test-cache-store.ts";

type Digests = ReturnType<typeof stampDigests>;

export async function binaryIdentity(file: string, digests: Digests) {
  const readStamp = async () => {
    const snapshot = await stat(file, { bigint: true });
    if (!snapshot.isFile()) throw new Error("Test runtime input must be a regular file.");
    return snapshot;
  };
  const before = await readStamp();
  const stamp = fileStamp(before);
  const content = await digests.hash(file, before);
  if (!content) throw new Error("Test runtime input changed during hashing.");
  return {
    digest: content,
    stamp,
    unchanged: async () => {
      const current = await readStamp().catch(() => undefined);
      return current !== undefined && stamp === fileStamp(current);
    },
  };
}

async function chromiumIdentity(digests: Digests) {
  const executable = chromium.executablePath();
  let revision = path.dirname(executable);
  while (!/^chromium-\d+$/u.test(path.basename(revision))) {
    const parent = path.dirname(revision);
    if (parent === revision) return;
    revision = parent;
  }
  // Playwright installs each Chromium revision once. A replacement launcher is
  // a new runtime input even when Playwright still reports the same revision.
  const canonical = await realpath(executable);
  const installedRevision = await realpath(revision);
  if (!relativeInput(installedRevision, canonical)) return;
  const binary = await binaryIdentity(canonical, digests);
  return {
    digest: digest(JSON.stringify([installedRevision, canonical, binary.stamp, binary.digest])),
    async unchanged() {
      return (
        canonical === (await realpath(executable).catch(() => undefined)) &&
        (await binary.unchanged())
      );
    },
  };
}

const browserEnvironment = (env: NodeJS.ProcessEnv) =>
  Object.entries(env)
    .filter(([name]) =>
      /^(?:NODE_ENV$|NODEX_BROWSER_TRACE$|RUNNER_DEBUG$|PLAYWRIGHT_|PWDEBUG$|VITEST_|(?:HTTP|HTTPS|ALL|NO)_PROXY$|SSL_CERT_)/iu.test(
        name,
      ),
    )
    .sort(([left], [right]) => left.localeCompare(right));

export function browserRuntimeIdentity(env: NodeJS.ProcessEnv, digests: Digests) {
  return chromiumIdentity(digests).then(
    (runtime) =>
      runtime && {
        digest: digest(
          JSON.stringify([os.release(), os.version(), runtime.digest, browserEnvironment(env)]),
        ),
        unchanged: runtime.unchanged,
      },
  );
}

export async function electronAddonIdentity(root: string, digests: Digests) {
  const require = createRequire(path.join(root, "package.json"));
  const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
  const release = path.join(packageRoot, "build", "Release");
  const prebuild = path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`);
  const capture = async (directory: string) =>
    (await readdir(directory, { withFileTypes: true }).catch(() => []))
      .filter(
        (entry) =>
          entry.isFile() && (entry.name.endsWith(".node") || entry.name === "spawn-helper"),
      )
      .map((entry) => path.join(directory, entry.name));
  const paths = async () => [...(await capture(release)), ...(await capture(prebuild))].sort();
  const files = await paths();
  if (!files.some((file) => file.endsWith(".node"))) return;
  const entries = await Promise.all(files.map((file) => binaryIdentity(file, digests)));
  return {
    digest: digest(
      JSON.stringify(
        entries.map((entry, index) => [relativeInput(packageRoot, files[index]), entry.digest]),
      ),
    ),
    async unchanged() {
      return (
        JSON.stringify(await paths()) === JSON.stringify(files) &&
        (await Promise.all(entries.map((entry) => entry.unchanged()))).every(Boolean)
      );
    },
  };
}
