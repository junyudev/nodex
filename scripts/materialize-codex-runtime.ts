import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { codexDefinition } from "../src/main/app-components/definitions/codex";
import { installAppComponent } from "../src/main/app-components/AppComponentStore";
import { ensureImmutableArtifact, resolveImmutableArtifactPath } from "./immutable-artifact-cache";
import { sha256File } from "./release/model";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** Install from the exact upstream archive using the same store and staging path as the app. */
export async function materializeMacCodexComponent(input: {
  readonly home: string;
  readonly resourcesPath: string;
  readonly projectRootPath?: string;
  readonly archivePath?: string;
}): Promise<void> {
  const definition = codexDefinition();
  const { archive } = definition;
  const archivePath =
    input.archivePath ??
    resolveImmutableArtifactPath({
      family: "agent-runtime",
      projectRoot: input.projectRootPath ?? repositoryRoot,
      assetName: archive.assetName,
      archiveSha256: archive.sha256,
    });
  if (!input.archivePath)
    await ensureImmutableArtifact({
      destinationPath: archivePath,
      expectedSize: archive.size,
      url: archive.url,
      label: "Codex",
      validate: (file) => {
        if (sha256File(file) !== archive.sha256)
          throw new Error("Codex archive checksum mismatch.");
      },
    });

  await installAppComponent({
    home: input.home,
    definition,
    codexNoticesDirectory: join(input.resourcesPath, "third-party", "codex"),
    fetch: async () =>
      new Response(Readable.toWeb(createReadStream(archivePath)) as ReadableStream, {
        headers: { "content-length": String(archive.size) },
      }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
    onProgress: () => undefined,
    onInstalling: () => undefined,
  });
}
