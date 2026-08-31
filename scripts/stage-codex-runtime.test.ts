import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { writeBrowserRuntimeFixture } from "../src/main/codex/browser-runtime-test-fixture";
import { resolveBrowserRuntimeBundle } from "../src/main/codex/browser-runtime-bundle";
import {
  projectBrowserPeerRuntimeIdentity,
  projectBundledAppServerRuntimeIdentity,
  type TestedBrowserAppServerPair,
} from "../src/shared/browser-app-server-compatibility";
import { BROWSER_RUNTIME_MANIFEST_FILENAME } from "../src/shared/browser-runtime-metadata";
import { parseBundledAgentRuntimeMetadata } from "../src/shared/codex-runtime-metadata";
import {
  stageCodexRuntime,
  stageCodexRuntimeCandidate,
  type StageAgentRuntimeOptions,
} from "./stage-codex-runtime";

const browserPairState = vi.hoisted(() => ({
  pairs: [] as readonly TestedBrowserAppServerPair[],
}));

vi.mock("./stage-browser-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stage-browser-runtime")>();
  return {
    ...actual,
    stageBrowserRuntime: (options: Parameters<typeof actual.stageBrowserRuntime>[0]) =>
      actual.stageBrowserRuntime({ ...options, testedPairs: browserPairState.pairs }),
  };
});

const roots: string[] = [];
const HASH = "a".repeat(64);

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function fixture(
  input: { readonly omitArtifact?: string; readonly restrictiveModes?: boolean } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nodex-codex-stage-test-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const projectRoot = path.join(root, "project");
  const outputPath = path.join(root, "output");
  const files = new Map([
    ["bin/codex-app-server", "app-server"],
    ["bin/codex-code-mode-host", "code-mode"],
    ["codex-path/rg", "rg"],
    ["codex-resources/zsh/bin/zsh", "zsh"],
  ]);
  for (const [relativePath, contents] of files) {
    if (relativePath === input.omitArtifact) continue;
    const pathname = path.join(sourceRoot, ...relativePath.split("/"));
    mkdirSync(path.dirname(pathname), { recursive: true });
    writeFileSync(pathname, contents);
    chmodSync(pathname, 0o755);
  }
  const packageManifest = {
    entrypoint: "bin/codex-app-server",
    layoutVersion: 1,
    pathDir: "codex-path",
    resourcesDir: "codex-resources",
    target: "aarch64-apple-darwin",
    variant: "codex-app-server",
    version: "0.152.0",
  };
  writeFileSync(
    path.join(sourceRoot, "codex-package.json"),
    `${JSON.stringify(packageManifest)}\n`,
  );
  if (input.restrictiveModes) {
    chmodSync(path.join(sourceRoot, "codex-package.json"), 0o600);
    for (const relativePath of files.keys()) {
      const pathname = path.join(sourceRoot, ...relativePath.split("/"));
      if (existsSync(pathname)) chmodSync(pathname, 0o700);
    }
  }
  const license = "Codex license\n";
  const notice = "Codex notice\n";
  const licensePath = path.join(projectRoot, "resources/third-party/codex/LICENSE");
  const noticePath = path.join(projectRoot, "resources/third-party/codex/NOTICE");
  mkdirSync(path.dirname(licensePath), { recursive: true });
  writeFileSync(licensePath, license);
  writeFileSync(noticePath, notice);
  const upstream = {
    checksumManifest: {
      assetName: "codex-package_SHA256SUMS",
      sha256: HASH,
      size: 123,
      url: "https://github.com/openai/codex/releases/download/rust-v0.152.0/codex-package_SHA256SUMS",
    },
    commit: "b".repeat(40),
    repository: "openai/codex",
    signingTeamId: "2DC432GLL2",
    tag: "rust-v0.152.0",
  };
  const build = (targetTriple: string, assetName: string) => ({
    archiveSha256: HASH,
    archiveSize: 1,
    assetName,
    entrypointSha256: sha256("app-server"),
    runtimeMetadataSha256: "0".repeat(64),
    targetTriple,
    url: `https://github.com/${upstream.repository}/releases/download/${upstream.tag}/${assetName}`,
  });
  const schemaTool = (targetTriple: string, assetName: string, entrypoint: string) => ({
    archiveSha256: HASH,
    archiveSize: 1,
    assetName,
    entrypoint,
    targetTriple,
    url: `https://github.com/openai/codex/releases/download/rust-v0.152.0/${assetName}`,
  });
  const lock = {
    appServerRuntimeVersion: "0.152.0",
    builds: {
      "darwin-arm64": build(
        "aarch64-apple-darwin",
        "codex-app-server-package-aarch64-apple-darwin.tar.gz",
      ),
      "darwin-x64": build(
        "x86_64-apple-darwin",
        "codex-app-server-package-x86_64-apple-darwin.tar.gz",
      ),
    },
    notices: {
      licensePath: "resources/third-party/codex/LICENSE",
      licenseSha256: sha256(license),
      noticePath: "resources/third-party/codex/NOTICE",
      noticeSha256: sha256(notice),
    },
    packageManifest: { ...packageManifest, target: undefined },
    protocolSchema: {
      experimental: true,
      sha256: HASH,
      tools: {
        "darwin-arm64": schemaTool(
          "aarch64-apple-darwin",
          "codex-aarch64-apple-darwin.tar.gz",
          "codex-aarch64-apple-darwin",
        ),
        "darwin-x64": schemaTool(
          "x86_64-apple-darwin",
          "codex-x86_64-apple-darwin.tar.gz",
          "codex-x86_64-apple-darwin",
        ),
      },
    },
    requiredArtifacts: ["codex-package.json", ...files.keys()],
    runtimeFamily: "codex-app-server",
    schemaVersion: 1,
    upstream,
  };
  const lockPath = path.join(root, "lock.json");
  writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);
  return { lock, lockPath, outputPath, packageManifest, projectRoot, root, sourceRoot };
}

type RuntimeFixture = ReturnType<typeof fixture>;

const persistLock = (input: RuntimeFixture): void => {
  writeFileSync(input.lockPath, `${JSON.stringify(input.lock)}\n`);
};

const stageOptions = (
  input: RuntimeFixture,
  overrides: Partial<StageAgentRuntimeOptions> = {},
): StageAgentRuntimeOptions => ({
  agentRuntimePlatformContractVerifier: () => undefined,
  lockPath: input.lockPath,
  outputPath: input.outputPath,
  projectRootPath: input.projectRoot,
  sourceRoot: input.sourceRoot,
  targetArch: "arm64",
  targetPlatform: "darwin",
  ...overrides,
});

const sealFixture = async (input: RuntimeFixture) => {
  const candidateOutputPath = path.join(input.root, "candidate-output");
  const candidate = await stageCodexRuntimeCandidate(
    stageOptions(input, { outputPath: candidateOutputPath }),
  );
  input.lock.builds["darwin-arm64"].runtimeMetadataSha256 = candidate.metadataSha256;
  input.lock.builds["darwin-arm64"].entrypointSha256 =
    candidate.metadata.releaseAsset.entrypointSha256;
  persistLock(input);
  rmSync(candidateOutputPath, { force: true, recursive: true });
  return candidate;
};

const writeArchiveFixture = (input: RuntimeFixture, additionalEntries: string[] = []) => {
  const build = input.lock.builds["darwin-arm64"];
  const archivePath = path.join(input.root, build.assetName);
  execFileSync("/usr/bin/tar", [
    "-czf",
    archivePath,
    "-C",
    input.sourceRoot,
    "bin",
    "codex-package.json",
    "codex-path",
    "codex-resources",
    ...additionalEntries,
  ]);
  const archiveBytes = readFileSync(archivePath);
  build.archiveSha256 = sha256(archiveBytes);
  build.archiveSize = archiveBytes.byteLength;
  const manifestBytes = Buffer.from(`${build.archiveSha256}  ${build.assetName}\n`);
  const manifestPath = path.join(input.root, input.lock.upstream.checksumManifest.assetName);
  writeFileSync(manifestPath, manifestBytes);
  input.lock.upstream.checksumManifest.sha256 = sha256(manifestBytes);
  input.lock.upstream.checksumManifest.size = manifestBytes.byteLength;
  persistLock(input);
  return { archiveBytes, archivePath, manifestBytes, manifestPath };
};

const sealArchiveFixture = async (input: RuntimeFixture) => {
  const archive = writeArchiveFixture(input);
  const candidate = await sealFixture(input);
  return { ...archive, candidate };
};

const testedBrowserPair = (
  metadata: Awaited<ReturnType<typeof sealFixture>>["metadata"],
  browserSourceRoot: string,
): TestedBrowserAppServerPair => {
  const manifestPath = path.join(browserSourceRoot, BROWSER_RUNTIME_MANIFEST_FILENAME);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Parameters<
    typeof projectBrowserPeerRuntimeIdentity
  >[0];
  return {
    appServer: projectBundledAppServerRuntimeIdentity(metadata),
    browser: projectBrowserPeerRuntimeIdentity(manifest, sha256(manifestBytes)),
  };
};

afterEach(() => {
  browserPairState.pairs = [];
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("stage-codex-runtime", () => {
  test("stages the canonical upstream package with exact official release provenance", async () => {
    const input = fixture();
    const candidate = await sealFixture(input);
    expect(candidate.metadata.sourceRevision).toEqual({
      commit: input.lock.upstream.commit,
      repository: input.lock.upstream.repository,
      tag: input.lock.upstream.tag,
    });
    expect(candidate.metadata.releaseAsset).toMatchObject({
      archiveSha256: input.lock.builds["darwin-arm64"].archiveSha256,
      archiveSize: input.lock.builds["darwin-arm64"].archiveSize,
      assetName: input.lock.builds["darwin-arm64"].assetName,
      repository: "openai/codex",
      tag: "rust-v0.152.0",
    });

    const metadata = await stageCodexRuntime(stageOptions(input));
    expect(metadata.artifacts.map((artifact) => artifact.path)).toContain(
      "third-party/codex/LICENSE",
    );
    expect(
      parseBundledAgentRuntimeMetadata(
        JSON.parse(
          readFileSync(path.join(input.outputPath, "agent-runtime/agent-runtime.json"), "utf8"),
        ),
      ),
    ).toEqual(metadata);
    expect(
      parseBundledAgentRuntimeMetadata({
        ...metadata,
        packageBuild: {},
      }),
    ).toBeNull();
    expect(
      parseBundledAgentRuntimeMetadata({
        ...metadata,
        releaseAsset: { ...metadata.releaseAsset, repository: "fork/codex" },
      }),
    ).toBeNull();
  });

  test("downloads, repairs, and reuses the lock-bound archive cache", async () => {
    const input = fixture();
    const { archiveBytes, manifestBytes } = await sealArchiveFixture(input);
    const build = input.lock.builds["darwin-arm64"];
    const cachePath = path.join(input.root, "cache");
    const cachedArchivePath = path.join(cachePath, build.archiveSha256, build.assetName);
    mkdirSync(path.dirname(cachedArchivePath), { recursive: true });
    writeFileSync(cachedArchivePath, "corrupt");
    const fetchArchive = vi.fn(async (url: string) => {
      const body = url === build.url ? archiveBytes : manifestBytes;
      expect([build.url, input.lock.upstream.checksumManifest.url]).toContain(url);
      return new Response(body, {
        headers: { "content-length": String(body.byteLength) },
        status: 200,
      });
    });

    const metadata = await stageCodexRuntime(
      stageOptions(input, {
        cachePath,
        fetch: fetchArchive,
        sourceRoot: undefined,
      }),
    );

    expect(metadata.targetArch).toBe("arm64");
    expect(fetchArchive).toHaveBeenCalledTimes(2);
    expect(sha256(readFileSync(cachedArchivePath))).toBe(build.archiveSha256);

    rmSync(input.outputPath, { force: true, recursive: true });
    const unexpectedFetch = vi.fn(async () => {
      throw new Error("verified cache should prevent a second download");
    });
    await stageCodexRuntime(
      stageOptions(input, {
        cachePath,
        fetch: unexpectedFetch,
        sourceRoot: undefined,
      }),
    );
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  test("extracts with the locked system boundary instead of a PATH-injected tar", async () => {
    const input = fixture();
    const { archivePath } = await sealArchiveFixture(input);
    const injectedBin = path.join(input.root, "injected-bin");
    mkdirSync(injectedBin, { recursive: true });
    writeFileSync(path.join(injectedBin, "tar"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${injectedBin}${path.delimiter}${previousPath ?? ""}`;
    try {
      const metadata = await stageCodexRuntime(
        stageOptions(input, { archivePath, sourceRoot: undefined }),
      );
      expect(metadata.targetArch).toBe("arm64");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("accepts an exact archive file closure and rejects an extra regular file", async () => {
    const exact = fixture();
    const exactArchive = writeArchiveFixture(exact);
    await expect(
      stageCodexRuntimeCandidate(
        stageOptions(exact, { archivePath: exactArchive.archivePath, sourceRoot: undefined }),
      ),
    ).resolves.toMatchObject({ metadata: { targetArch: "arm64" } });

    const extra = fixture();
    writeFileSync(path.join(extra.sourceRoot, "unexpected.txt"), "must not be published\n");
    const extraArchive = writeArchiveFixture(extra, ["unexpected.txt"]);
    await expect(
      stageCodexRuntimeCandidate(
        stageOptions(extra, { archivePath: extraArchive.archivePath, sourceRoot: undefined }),
      ),
    ).rejects.toThrow("unexpected: unexpected.txt");
  });

  test("requires the reviewed checksum manifest to bind the staged archive", async () => {
    const input = fixture();
    const { archivePath, manifestPath } = writeArchiveFixture(input);
    const wrongManifest = Buffer.from(`${"f".repeat(64)}  ${path.basename(archivePath)}\n`);
    writeFileSync(manifestPath, wrongManifest);
    input.lock.upstream.checksumManifest.sha256 = sha256(wrongManifest);
    input.lock.upstream.checksumManifest.size = wrongManifest.byteLength;
    persistLock(input);

    await expect(
      stageCodexRuntimeCandidate(stageOptions(input, { archivePath, sourceRoot: undefined })),
    ).rejects.toThrow("does not bind");
  });

  test("does not stage an archive whose downloaded bytes miss the lock", async () => {
    const input = fixture();
    const { archiveBytes, manifestBytes } = await sealArchiveFixture(input);
    const corruptedBytes = Buffer.from(archiveBytes);
    corruptedBytes[corruptedBytes.length - 1] ^= 1;

    await expect(
      stageCodexRuntime(
        stageOptions(input, {
          cachePath: path.join(input.root, "cache"),
          fetch: async (url) => {
            const body =
              url === input.lock.upstream.checksumManifest.url ? manifestBytes : corruptedBytes;
            return new Response(body, {
              headers: { "content-length": String(body.byteLength) },
              status: 200,
            });
          },
          sourceRoot: undefined,
        }),
      ),
    ).rejects.toThrow("archive checksum mismatch");
    expect(existsSync(path.join(input.outputPath, "agent-runtime"))).toBe(false);
  });

  test("rejects a staged entrypoint whose identity differs from the release lock", async () => {
    const input = fixture();
    await sealFixture(input);
    input.lock.builds["darwin-arm64"].entrypointSha256 = "b".repeat(64);
    persistLock(input);

    await expect(stageCodexRuntime(stageOptions(input))).rejects.toThrow(
      "entrypoint does not match the release lock",
    );
    expect(existsSync(path.join(input.outputPath, "agent-runtime"))).toBe(false);
  });

  test("normalizes all staged runtime modes independently of source modes and umask", async () => {
    const input = fixture({ restrictiveModes: true });
    await sealFixture(input);

    const previousUmask = process.umask(0o077);
    let metadata;
    try {
      metadata = await stageCodexRuntime(stageOptions(input));
    } finally {
      process.umask(previousUmask);
    }

    const runtimeRoot = path.join(input.outputPath, "agent-runtime");
    for (const artifact of metadata.artifacts) {
      const artifactPath = path.join(runtimeRoot, ...artifact.path.split("/"));
      expect(statSync(artifactPath).mode & 0o777).toBe(artifact.executable ? 0o755 : 0o644);
    }
    expect(statSync(path.join(runtimeRoot, "agent-runtime.json")).mode & 0o777).toBe(0o644);
  });

  test("activates an exact tested Browser pair inside the Agent runtime transaction", async () => {
    const input = fixture();
    const candidate = await sealFixture(input);
    const browserSourceRoot = path.join(input.root, "browser-source");
    const browserManifest = writeBrowserRuntimeFixture(browserSourceRoot);
    const pair = testedBrowserPair(candidate.metadata, browserSourceRoot);
    browserPairState.pairs = [pair];
    mkdirSync(path.join(input.outputPath, "agent-runtime"), { recursive: true });
    writeFileSync(path.join(input.outputPath, "agent-runtime", "stale"), "stale");

    await stageCodexRuntime(
      stageOptions(input, {
        browserRuntimePlatformArtifactVerifier: () => null,
        browserRuntimeSourceRoot: browserSourceRoot,
      }),
    );

    const runtimeRoot = path.join(input.outputPath, "agent-runtime");
    expect(existsSync(path.join(runtimeRoot, "stale"))).toBe(false);
    const resolvedBrowser = resolveBrowserRuntimeBundle({
      appServerIdentity: pair.appServer,
      platformArtifactVerifier: () => null,
      runtimeRoot,
      targetArch: "arm64",
      targetPlatform: "darwin",
      testedPairs: [pair],
    });
    expect(resolvedBrowser.status).toBe("available");
    if (resolvedBrowser.status === "available") {
      expect(resolvedBrowser.bundle.manifest.browserPlugin.version).toBe(
        browserManifest.browserPlugin.version,
      );
    }
  });

  test("reuses a verified closure and repairs modes, bytes, and symlinks", async () => {
    const input = fixture();
    await sealFixture(input);
    const options = stageOptions(input, { reuseExisting: true });
    await stageCodexRuntime(options);
    const runtimeRoot = path.join(input.outputPath, "agent-runtime");
    const entrypoint = path.join(runtimeRoot, "bin", "codex-app-server");
    const metadataPath = path.join(runtimeRoot, "agent-runtime.json");
    const initialModifiedAt = statSync(entrypoint).mtimeMs;

    await stageCodexRuntime(options);
    expect(statSync(entrypoint).mtimeMs).toBe(initialModifiedAt);

    chmodSync(entrypoint, 0o700);
    chmodSync(metadataPath, 0o600);
    await stageCodexRuntime(options);
    expect(statSync(entrypoint).mode & 0o777).toBe(0o755);
    expect(statSync(metadataPath).mode & 0o777).toBe(0o644);

    const policyDrift = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    policyDrift.releaseAsset = {
      ...(policyDrift.releaseAsset as Record<string, unknown>),
      tag: "rust-v0.152.1",
    };
    writeFileSync(metadataPath, `${JSON.stringify(policyDrift, null, 2)}\n`);
    chmodSync(metadataPath, 0o644);
    await stageCodexRuntime(options);
    const repairedPolicy = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      releaseAsset: { tag: string };
    };
    expect(repairedPolicy.releaseAsset.tag).toBe("rust-v0.152.0");

    writeFileSync(entrypoint, "damaged");
    await stageCodexRuntime(options);
    expect(readFileSync(entrypoint, "utf8")).toBe("app-server");

    const externalEntrypoint = path.join(input.root, "external-entrypoint");
    writeFileSync(externalEntrypoint, "external");
    unlinkSync(entrypoint);
    symlinkSync(externalEntrypoint, entrypoint);
    await stageCodexRuntime(options);
    expect(lstatSync(entrypoint).isSymbolicLink()).toBe(false);
    expect(readFileSync(entrypoint, "utf8")).toBe("app-server");

    const externalRuntimeRoot = path.join(input.root, "external-runtime");
    renameSync(runtimeRoot, externalRuntimeRoot);
    symlinkSync(externalRuntimeRoot, runtimeRoot, "dir");
    await stageCodexRuntime(options);
    expect(lstatSync(runtimeRoot).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(externalRuntimeRoot, "agent-runtime.json"))).toBe(true);
  });

  test.each(["bin/codex-code-mode-host", "codex-path/rg"])(
    "rejects a source missing required closure artifact %s",
    async (omitArtifact) => {
      const input = fixture({ omitArtifact });

      await expect(stageCodexRuntimeCandidate(stageOptions(input))).rejects.toThrow(omitArtifact);
      expect(existsSync(path.join(input.outputPath, "agent-runtime"))).toBe(false);
    },
  );

  test("rejects package metadata that drifts from the target", async () => {
    const input = fixture();
    writeFileSync(
      path.join(input.sourceRoot, "codex-package.json"),
      `${JSON.stringify({ ...input.packageManifest, target: "x86_64-apple-darwin" })}\n`,
    );
    await expect(
      stageCodexRuntimeCandidate({
        lockPath: input.lockPath,
        outputPath: input.outputPath,
        projectRootPath: input.projectRoot,
        sourceRoot: input.sourceRoot,
        targetArch: "arm64",
        targetPlatform: "darwin",
      }),
    ).rejects.toThrow("package manifest does not match");
  });
});
