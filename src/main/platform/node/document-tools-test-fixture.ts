import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  WORKSPACE_RUNTIME_MANIFEST,
  type WorkspaceRuntimeManifest,
} from "../../../shared/workspace-dependency-runtime";

export function writeDocumentToolsFixture(root: string, sourceLockSha256 = "a".repeat(64)) {
  const pythonExecutable = "python/bin/python3.13";
  const pythonSitePackages = "python/lib/python3.13/site-packages";
  const files = [
    { path: pythonExecutable, bytes: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), executable: true },
    {
      path: `${pythonSitePackages}/example.py`,
      bytes: Buffer.from("example = True\n"),
      executable: false,
    },
    { path: "licenses/python/LICENSE", bytes: Buffer.from("fixture notice\n"), executable: false },
  ];
  const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const manifest: WorkspaceRuntimeManifest = {
    schemaVersion: 1,
    targetPlatform: "darwin",
    targetArch: "arm64",
    sourceLockSha256,
    distributionId: "fixture-python",
    pythonVersion: "3.13.15",
    pythonExecutable,
    pythonSitePackages,
    libraries: [{ name: "example", version: "1.0" }],
    artifacts: files.map(({ path, bytes, executable }) => ({
      path,
      executable,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    })),
  };
  for (const file of files) {
    const destination = path.join(root, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes, { mode: file.executable ? 0o755 : 0o644 });
  }
  const raw = JSON.stringify(manifest);
  writeFileSync(path.join(root, WORKSPACE_RUNTIME_MANIFEST), raw);
  return {
    manifest,
    payload: { kind: "document-tools", manifestSha256: sha256(raw) } as const,
    unpackedBytes:
      Buffer.byteLength(raw) + files.reduce((total, file) => total + file.bytes.byteLength, 0),
  };
}
