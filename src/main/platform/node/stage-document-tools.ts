/* @effect-diagnostics asyncFunction:off -- Workspace archive staging verifies the Node filesystem. */
import type { AppComponentPayload } from "../../app-components/AppComponentCatalog";
import { verifyWorkspaceDependencyBundle } from "./WorkspaceDependencyBundle";

export async function stageDocumentTools(
  root: string,
  payload: Extract<AppComponentPayload, { kind: "document-tools" }>,
  signal: AbortSignal,
): Promise<number> {
  const { unpackedBytes } = await verifyWorkspaceDependencyBundle(
    { root, platform: "darwin", arch: "arm64" },
    { manifestSha256: payload.manifestSha256, signal },
  );
  return unpackedBytes;
}
