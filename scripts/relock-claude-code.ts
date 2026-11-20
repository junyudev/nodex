import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  extractPinnedTarArchive,
  inventoryRegularFiles,
  sha256File,
} from "../src/main/platform/node/pinned-tar-archive";

const target = "darwin-arm64";
const platformPackage = `@anthropic-ai/claude-agent-sdk-${target}`;
const executablePath = "package/claude";

export function installedClaudeAgentSdkVersion(): string {
  const require = createRequire(import.meta.url);
  const sdkRoot = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
  return JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version as string;
}

async function relockClaudeCode(): Promise<void> {
  const version = installedClaudeAgentSdkVersion();
  const registry = "https://registry.npmjs.org";
  const url = `${registry}/${platformPackage}/-/claude-agent-sdk-${target}-${version}.tgz`;
  const signal = AbortSignal.timeout(600_000);
  const metadata = await fetch(`${registry}/${encodeURIComponent(platformPackage)}/${version}`, {
    signal,
  });
  if (!metadata.ok) throw new Error(`Claude Code metadata returned HTTP ${metadata.status}`);
  const info = (await metadata.json()) as {
    version: string;
    dist: { tarball: string; integrity: string; unpackedSize: number };
  };
  if (
    info.version !== version ||
    info.dist.tarball !== url ||
    !info.dist.integrity.startsWith("sha512-")
  ) {
    throw new Error("Unexpected registry metadata for Claude Code.");
  }

  const temporary = await mkdtemp(join(tmpdir(), "nodex-claude-relock-"));
  try {
    const archive = join(temporary, "claude.tgz");
    const root = join(temporary, "stage");
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body)
      throw new Error(`Claude Code archive returned HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(archive), {
      signal,
    });
    const integrity = createHash("sha512");
    for await (const chunk of createReadStream(archive, { signal })) integrity.update(chunk);
    if (`sha512-${integrity.digest("base64")}` !== info.dist.integrity) {
      throw new Error("Claude Code archive differs from the registry integrity hash.");
    }
    await mkdir(root);
    await extractPinnedTarArchive(archive, root, signal);
    const files = await inventoryRegularFiles(root, signal);
    const unpackedSize = Array.from(files.values()).reduce((sum, entry) => sum + entry.size, 0);
    const executable = files.get(executablePath);
    if (!executable || unpackedSize !== info.dist.unpackedSize) {
      throw new Error("Claude Code archive differs from the registry payload.");
    }
    const payload = {
      kind: "claude-code",
      executable: {
        path: executablePath,
        size: executable.size,
        sha256: await sha256File(join(root, executablePath), signal),
      },
    } as const;
    const { stageClaudeCode } = await import("../src/main/platform/node/stage-claude-code");
    await stageClaudeCode(root, payload, signal);
    const lock = {
      version,
      assets: {
        [target]: {
          url,
          archiveSize: (await lstat(archive)).size,
          archiveSha256: await sha256File(archive, signal),
          unpackedSize,
          executable: payload.executable,
        },
      },
    };
    await writeFile(
      new URL("../resources/agent-runtime/claude-code.lock.json", import.meta.url),
      `${JSON.stringify(lock, null, 2)}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  relockClaudeCode().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
