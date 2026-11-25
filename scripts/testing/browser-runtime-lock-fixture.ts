export function windowsBrowserRuntimeLockFixture(desktopBuild: string) {
  const asset = {
    appServer: {
      entrypointSha256: "a".repeat(64),
      protocolSchemaFingerprint: "b".repeat(64),
      runtimeVersion: "1.0.0",
      sourceCommit: "c".repeat(40),
      targetArch: "x64",
      targetPlatform: "win32",
    },
    archiveSha256: "a".repeat(64),
    archiveSize: 123,
    assetName: `nodex-browser-runtime-${desktopBuild}-win32-x64.tar.gz`,
    manifestSha256: "b".repeat(64),
    runtimeVersions: { codexCli: "0.146.0", cuaRuntime: "0.0.6/build", node: "24.14.0" },
    sourcePackage: { name: "OpenAI.Codex", publisher: "CN=Example", version: "1.0.0.0" },
    url: null,
  };
  return { "win32-x64": asset };
}
