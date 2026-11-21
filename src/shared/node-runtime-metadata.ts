import { z } from "zod";
import releaseLock from "../../resources/agent-runtime/node-runtime.lock.json";

export const nodeRuntimeRelease = releaseLock;
export type StandaloneNodeArchitecture = "x64" | "arm64";
export type StandaloneNodeTarget =
  | { readonly platform: "darwin"; readonly arch: "arm64" }
  | { readonly platform: "win32"; readonly arch: StandaloneNodeArchitecture };

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    targetPlatform: z.enum(["darwin", "win32"]),
    targetArch: z.enum(["x64", "arm64"]),
    version: z.string().min(1),
    executable: z.enum(["node", "node.exe"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    size: z.number().int().positive(),
  })
  .strict();

/** The manifest describes the release-locked binary; it cannot authorize different bytes. */
export function parseStandaloneNodeManifest(
  value: unknown,
  target: StandaloneNodeArchitecture | StandaloneNodeTarget,
  release = nodeRuntimeRelease,
) {
  const { platform, arch } =
    typeof target === "string" ? { platform: "win32" as const, arch: target } : target;
  const manifest = manifestSchema.parse(value);
  const expected =
    platform === "darwin" ? release.builds["darwin-arm64"] : release.builds[`win32-${arch}`];
  if (
    manifest.targetPlatform !== platform ||
    manifest.targetArch !== arch ||
    manifest.executable !== (platform === "darwin" ? "node" : "node.exe") ||
    manifest.version !== release.version ||
    manifest.sha256 !== expected.sha256 ||
    manifest.size !== expected.size
  )
    throw new Error("Standalone Node manifest differs from the release lock");
  return manifest;
}
