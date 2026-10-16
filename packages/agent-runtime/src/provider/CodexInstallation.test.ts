import { expect, test } from "vite-plus/test";
import releaseLock from "../../../../resources/agent-runtime/codex-app-server.lock.json" with { type: "json" };
import { resolveCodexReleaseAsset } from "./CodexInstallation.ts";

test.each([
  ["darwin", "arm64", "darwin-arm64"],
  ["linux", "arm64", "linux-arm64"],
  ["linux", "x64", "linux-x64"],
  ["win32", "arm64", "win32-arm64"],
  ["win32", "x64", "win32-x64"],
] as const)("installs the locked official Codex release on %s/%s", (platform, arch, key) => {
  const build = releaseLock.builds[key];
  expect(resolveCodexReleaseAsset(platform, arch)).toEqual({
    version: releaseLock.appServerRuntimeVersion,
    target: build.targetTriple,
    url: build.url,
    sha256: build.archiveSha256,
    archiveBytes: build.archiveSize,
  });
});

test.each([
  ["darwin", "x64"],
  ["linux", "ia32"],
  ["freebsd", "arm64"],
] as const)("does not offer a managed Codex release on %s/%s", (platform, arch) => {
  expect(resolveCodexReleaseAsset(platform, arch)).toBeNull();
});
