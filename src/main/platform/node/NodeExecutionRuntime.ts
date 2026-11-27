import fs from "node:fs/promises";
import path from "node:path";
import {
  nodeRuntimeRelease,
  parseStandaloneNodeManifest,
} from "../../../shared/node-runtime-metadata";
import { readRuntimeArtifactSha256 } from "./RuntimeArtifactVerification";

export type NodeExecutionRuntime =
  | {
      readonly status: "available";
      readonly executable: string;
      readonly version: string;
      readonly source: "standalone";
    }
  | { readonly status: "unavailable"; readonly message: string };

/** Verify Node independently of optional browser tooling on hosts with a standalone distribution. */
export async function resolveNodeExecutionRuntime(input: {
  readonly platform: string;
  readonly architecture: string;
  readonly directory: string;
  readonly release?: typeof nodeRuntimeRelease;
  readonly signal?: AbortSignal;
}): Promise<NodeExecutionRuntime> {
  input.signal?.throwIfAborted();
  const { platform, architecture } = input;
  if (platform !== "darwin" && platform !== "win32")
    return { status: "unavailable", message: "The verified Node execution runtime is unavailable" };
  try {
    if (architecture !== "x64" && architecture !== "arm64")
      throw new Error("Unsupported standalone Node architecture");
    if (platform === "darwin" && architecture !== "arm64")
      throw new Error("Unsupported standalone Node architecture");
    const directory = await fs.lstat(input.directory);
    const manifestPath = path.join(input.directory, "node-runtime.json");
    const metadata = await fs.lstat(manifestPath);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16_384
    )
      throw new Error("Standalone Node manifest must be a bounded regular file");
    const manifest = parseStandaloneNodeManifest(
      JSON.parse(await fs.readFile(manifestPath, { encoding: "utf8", signal: input.signal })),
      platform === "darwin" ? { platform, arch: "arm64" } : { platform, arch: architecture },
      input.release,
    );
    const executable = path.join(input.directory, manifest.executable);
    const binary = await fs.lstat(executable);
    if (
      !binary.isFile() ||
      binary.isSymbolicLink() ||
      (platform === "darwin" && (binary.mode & 0o111) === 0) ||
      binary.size !== manifest.size ||
      (await readRuntimeArtifactSha256(executable, input.signal)) !== manifest.sha256
    )
      throw new Error("Standalone Node executable differs from its release lock");
    input.signal?.throwIfAborted();
    return { status: "available", source: "standalone", executable, version: manifest.version };
  } catch (error) {
    input.signal?.throwIfAborted();
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
