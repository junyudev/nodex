import { z } from "zod";
import releaseLock from "../../resources/agent-runtime/node-runtime.lock.json";

export const nodeRuntimeRelease = releaseLock;
export type StandaloneNodeArchitecture = "x64" | "arm64";

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    targetPlatform: z.literal("win32"),
    targetArch: z.enum(["x64", "arm64"]),
    version: z.string().min(1),
    executable: z.literal("node.exe"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    size: z.number().int().positive(),
  })
  .strict();

/** The manifest describes the release-locked binary; it cannot authorize different bytes. */
export function parseStandaloneNodeManifest(
  value: unknown,
  arch: StandaloneNodeArchitecture,
  release = nodeRuntimeRelease,
) {
  const manifest = manifestSchema.parse(value);
  const expected = release.builds[`win32-${arch}`];
  if (
    manifest.targetArch !== arch ||
    manifest.version !== release.version ||
    manifest.sha256 !== expected.sha256 ||
    manifest.size !== expected.size
  )
    throw new Error("Standalone Node manifest differs from the release lock");
  return manifest;
}
