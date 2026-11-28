import type { AppComponentDefinition } from "../../src/main/app-components/AppComponentCatalog";

const hash = (character: string) => character.repeat(64);
const archive = (assetName: string, character: string) => ({
  assetName,
  url: `https://example.test/${assetName}`,
  sha256: hash(character),
  size: 100,
});

export const windowsComponentPins: readonly AppComponentDefinition[] = [
  {
    id: "desktop-tools",
    install: "at-startup",
    archive: archive("desktop-tools.tar.gz", "1"),
    unpackedBytes: 200,
    payload: { kind: "desktop-tools", manifestSha256: hash("2") },
  },
  {
    id: "codex",
    install: "on-first-use",
    archive: archive("codex.tar.gz", "3"),
    unpackedBytes: 200,
    payload: { kind: "codex", metadataSha256: hash("4"), entrypointSha256: hash("5") },
  },
  {
    id: "claude-code",
    install: "on-first-use",
    archive: archive("claude-code.tgz", "6"),
    unpackedBytes: 200,
    payload: {
      kind: "claude-code",
      executable: { path: "package/claude.exe", size: 150, sha256: hash("7") },
    },
  },
];

export function windowsProbeFixture() {
  const marker = "NODEX_PTY_00000000-0000-4000-8000-000000000001";
  const receipts = windowsComponentPins.map((pin) => ({
    pin,
    root: `C:/probe/Profile/components/${pin.id}/${pin.archive.sha256}`,
    activated: true,
    installedBytes: 208,
  }));
  return {
    failures: [],
    evidence: { componentPayloadsAbsent: true },
    components: {
      receipts,
      codex: { executable: `${receipts[1]!.root}/bin/codex.exe`, version: "codex 1", images: 6 },
      claudeCode: { executable: `${receipts[2]!.root}/package/claude.exe`, version: "Claude 1" },
      desktopTools: {
        status: "passed",
        rootPath: `${receipts[0]!.root}/browser-runtime`,
        signedImages: 22,
        processesClosed: 2,
      },
    },
    normalQuit: {},
    upgrade: {},
    uninstall: {},
    packagedPty: {
      schemaVersion: 1,
      nodeExecutable: "C:/installed/resources/node-runtime/node.exe",
      addonPath: "C:/installed/resources/agent-runtime/node_modules/node-pty",
      platform: "win32",
      architecture: "x64",
      marker,
      output: marker,
      exitCode: 73,
      ptyPid: 123,
    },
  };
}
