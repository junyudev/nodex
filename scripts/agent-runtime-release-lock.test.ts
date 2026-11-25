import path, { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  CODEX_APP_SERVER_REQUIRED_ARTIFACTS,
  parseCodexAppServerReleaseLock,
  readCodexAppServerReleaseLock,
  type CodexAppServerReleaseLock,
} from "./agent-runtime-release-lock";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import {
  createAgentRuntimeRelockCandidate,
  parseAgentRuntimeRelockCli,
  writeAgentRuntimeRelockCandidate,
} from "./relock-agent-runtime";
import { stageCodexRuntime } from "./stage-codex-runtime";

const HASH = "a".repeat(64);
const COMMIT = "316795b3cf2a45e90d121d9f46499d4658b2645c";
const TAG = "rust-v0.152.0";
const releaseUrl = (assetName: string) =>
  `https://github.com/openai/codex/releases/download/${TAG}/${assetName}`;

function makeLock(): Record<string, unknown> {
  const build = (targetTriple: string) => {
    const assetName = `codex-package-${targetTriple}.tar.gz`;
    return {
      archiveSha256: HASH,
      archiveSize: 123,
      assetName,
      entrypointSha256: HASH,
      runtimeMetadataSha256: HASH,
      targetTriple,
      url: releaseUrl(assetName),
    };
  };
  const managedBuild = (targetTriple: string) => {
    const {
      entrypointSha256: _entrypoint,
      runtimeMetadataSha256: _metadata,
      ...archive
    } = build(targetTriple);
    if (targetTriple.includes("windows"))
      return {
        ...archive,
        entrypointSha256: HASH,
        runtimeMetadataSha256: HASH,
        requiredArtifacts: [
          "codex-package.json",
          "bin/codex.exe",
          "bin/codex-code-mode-host.exe",
          "codex-path/rg.exe",
          "codex-resources/codex-command-runner.exe",
          "codex-resources/codex-windows-sandbox-setup.exe",
        ],
      };
    return archive;
  };
  const schemaTool = (targetTriple: string) => {
    const assetName = `codex-${targetTriple}.tar.gz`;
    return {
      archiveSha256: HASH,
      archiveSize: 123,
      assetName,
      entrypoint: `codex-${targetTriple}`,
      targetTriple,
      url: releaseUrl(assetName),
    };
  };
  return {
    appServerRuntimeVersion: "0.152.0",
    builds: {
      "darwin-arm64": build("aarch64-apple-darwin"),
      "linux-arm64": managedBuild("aarch64-unknown-linux-musl"),
      "linux-x64": managedBuild("x86_64-unknown-linux-musl"),
      "win32-x64": managedBuild("x86_64-pc-windows-msvc"),
    },
    notices: {
      licensePath: "resources/third-party/codex/LICENSE",
      licenseSha256: HASH,
      noticePath: "resources/third-party/codex/NOTICE",
      noticeSha256: HASH,
    },
    packageManifest: {
      entrypoint: "bin/codex",
      execServer: "bin/codex-exec-server",
      layoutVersion: 1,
      pathDir: "codex-path",
      resourcesDir: "codex-resources",
      variant: "codex",
      version: "0.152.0",
    },
    protocolSchema: {
      experimental: true,
      sha256: HASH,
      tools: {
        "darwin-arm64": schemaTool("aarch64-apple-darwin"),
      },
    },
    requiredArtifacts: [...CODEX_APP_SERVER_REQUIRED_ARTIFACTS],
    runtimeFamily: "codex",
    schemaVersion: 1,
    upstream: {
      checksumManifest: {
        assetName: "codex-package_SHA256SUMS",
        sha256: HASH,
        size: 123,
        url: releaseUrl("codex-package_SHA256SUMS"),
      },
      commit: COMMIT,
      repository: "openai/codex",
      signingTeamId: "2DC432GLL2",
      tag: TAG,
    },
  };
}

test("binds runtime archives, schema tools, and checksum manifest to one official release", () => {
  const lock = parseCodexAppServerReleaseLock(makeLock());
  expect(lock.upstream).toMatchObject({ commit: COMMIT, repository: "openai/codex", tag: TAG });
  expect(lock.builds["darwin-arm64"].url).toBe(
    releaseUrl("codex-package-aarch64-apple-darwin.tar.gz"),
  );
  expect(lock.upstream.checksumManifest.url).toBe(releaseUrl("codex-package_SHA256SUMS"));
});

test("accepts the canonical no-patch runtime lock", () => {
  const lock = readCodexAppServerReleaseLock(
    resolve("resources/agent-runtime/codex-app-server.lock.json"),
  );
  expect(lock.schemaVersion).toBe(1);
  expect(lock.requiredArtifacts).toEqual(
    expect.arrayContaining([...CODEX_APP_SERVER_REQUIRED_ARTIFACTS]),
  );
  expect(lock.upstream.tag).toBe(`rust-v${lock.appServerRuntimeVersion}`);
});

test("rejects runtime assets and checksum manifests outside the official release", () => {
  const assetDrift = makeLock();
  (assetDrift.builds as Record<string, Record<string, unknown>>)["darwin-arm64"]!.url =
    "https://example.com/runtime.tar.gz";
  expect(() => parseCodexAppServerReleaseLock(assetDrift)).toThrow("locked official Codex release");

  const manifestDrift = makeLock();
  const upstream = manifestDrift.upstream as Record<string, unknown>;
  (upstream.checksumManifest as Record<string, unknown>).url = "https://example.com/SHA256SUMS";
  expect(() => parseCodexAppServerReleaseLock(manifestDrift)).toThrow("checksumManifest.url");
});

test("requires exact supported targets and the canonical runtime artifacts", () => {
  const extraTarget = makeLock();
  const builds = extraTarget.builds as Record<string, unknown>;
  builds["darwin-arm64-debug"] = builds["darwin-arm64"];
  expect(() => parseCodexAppServerReleaseLock(extraTarget)).toThrow(
    "the four supported release targets",
  );

  const missingArtifact = makeLock();
  missingArtifact.requiredArtifacts = CODEX_APP_SERVER_REQUIRED_ARTIFACTS.slice(0, -1);
  expect(() => parseCodexAppServerReleaseLock(missingArtifact)).toThrow(
    "canonical runtime artifacts",
  );

  const extendedClosure = makeLock();
  extendedClosure.requiredArtifacts = [
    ...CODEX_APP_SERVER_REQUIRED_ARTIFACTS,
    "codex-resources/voice/bin/codex-voice-host",
  ];
  expect(parseCodexAppServerReleaseLock(extendedClosure).requiredArtifacts).toEqual(
    extendedClosure.requiredArtifacts,
  );

  const duplicateArtifact = makeLock();
  duplicateArtifact.requiredArtifacts = [
    ...CODEX_APP_SERVER_REQUIRED_ARTIFACTS,
    CODEX_APP_SERVER_REQUIRED_ARTIFACTS[0],
  ];
  expect(() => parseCodexAppServerReleaseLock(duplicateArtifact)).toThrow("duplicates");

  const packageLayoutDrift = makeLock();
  (packageLayoutDrift.packageManifest as Record<string, unknown>).pathDir = "bin";
  expect(() => parseCodexAppServerReleaseLock(packageLayoutDrift)).toThrow(
    "canonical release package",
  );

  const execServerDrift = makeLock();
  (execServerDrift.packageManifest as Record<string, unknown>).execServer = "bin/other";
  expect(() => parseCodexAppServerReleaseLock(execServerDrift)).toThrow("package exec server");

  const noticeDrift = makeLock();
  (noticeDrift.notices as Record<string, unknown>).noticePath = "NOTICE";
  expect(() => parseCodexAppServerReleaseLock(noticeDrift)).toThrow("canonical legal closure");
});

test("rejects source-build or patch provenance fields", () => {
  const lock = makeLock();
  lock.source = { patches: [] };
  expect(() => parseCodexAppServerReleaseLock(lock)).toThrow("header");
});

test("requires a full immutable upstream commit and matching release tag", () => {
  const shortCommit = makeLock();
  (shortCommit.upstream as Record<string, unknown>).commit = "316795b3";
  expect(() => parseCodexAppServerReleaseLock(shortCommit)).toThrow("upstream.commit");

  const wrongTag = makeLock();
  (wrongTag.upstream as Record<string, unknown>).tag = "rust-v0.152.1";
  expect(() => parseCodexAppServerReleaseLock(wrongTag)).toThrow("rust-v0.152.0");
});

test("requires the reviewed OpenAI signing team and canonical schema tool assets", () => {
  const wrongTeam = makeLock();
  (wrongTeam.upstream as Record<string, unknown>).signingTeamId = "8HGUT3HC4Z";
  expect(() => parseCodexAppServerReleaseLock(wrongTeam)).toThrow("upstream.signingTeamId");

  const wrongAsset = makeLock();
  const tools = (wrongAsset.protocolSchema as Record<string, unknown>).tools as Record<
    string,
    Record<string, unknown>
  >;
  tools["darwin-arm64"]!.assetName = "codex-app-server-aarch64-apple-darwin.tar.gz";
  tools["darwin-arm64"]!.url = releaseUrl(String(tools["darwin-arm64"]!.assetName));
  expect(() => parseCodexAppServerReleaseLock(wrongAsset)).toThrow("schema tool asset name");

  const wrongEntrypoint = makeLock();
  const entrypointTools = (wrongEntrypoint.protocolSchema as Record<string, unknown>)
    .tools as Record<string, Record<string, unknown>>;
  entrypointTools["darwin-arm64"]!.entrypoint = "codex";
  expect(() => parseCodexAppServerReleaseLock(wrongEntrypoint)).toThrow("schema tool entrypoint");
});

test("rejects managed installation archives from another release or target", () => {
  const wrongRelease = makeLock();
  const releaseBuilds = wrongRelease.builds as Record<string, Record<string, unknown>>;
  releaseBuilds["linux-x64"]!.url = String(releaseBuilds["linux-x64"]!.url).replace(
    TAG,
    "rust-v0.151.0",
  );
  expect(() => parseCodexAppServerReleaseLock(wrongRelease)).toThrow(
    "locked official Codex release",
  );

  const wrongTarget = makeLock();
  const targetBuilds = wrongTarget.builds as Record<string, Record<string, unknown>>;
  targetBuilds["win32-x64"]!.targetTriple = "x86_64-unknown-linux-musl";
  expect(() => parseCodexAppServerReleaseLock(wrongTarget)).toThrow("targetTriple");
});

describe("relocking an official runtime archive", () => {
  const roots: string[] = [];
  const sha256 = (value: string | Buffer): string =>
    createHash("sha256").update(value).digest("hex");
  const skipPlatformInspection = () => undefined;

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createArchive(
    root: string,
    target: string,
    version: string,
    requiredArtifacts: readonly string[],
  ): string {
    const packageRoot = path.join(root, `package-${target}`);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, "codex-package.json"),
      `${JSON.stringify({
        entrypoint: "bin/codex",
        execServer: "bin/codex-exec-server",
        layoutVersion: 1,
        pathDir: "codex-path",
        resourcesDir: "codex-resources",
        target,
        variant: "codex",
        version,
      })}\n`,
    );
    const executableArtifacts = new Set([
      "bin/codex",
      "bin/codex-code-mode-host",
      "bin/codex-exec-server",
      "codex-path/rg",
      "codex-resources/voice/bin/codex-voice-host",
    ]);
    for (const artifact of requiredArtifacts) {
      if (artifact === "codex-package.json") continue;
      const filePath = path.join(packageRoot, artifact);
      mkdirSync(path.dirname(filePath), { recursive: true });
      const executable = executableArtifacts.has(artifact);
      writeFileSync(filePath, executable ? "#!/bin/sh\nexit 0\n" : `fixture:${artifact}\n`);
      chmodSync(filePath, executable ? 0o755 : 0o644);
    }
    const archivePath = path.join(root, `codex-package-${target}.tar.gz`);
    execFileSync("/usr/bin/tar", [
      "-czf",
      archivePath,
      "-C",
      packageRoot,
      "bin",
      "codex-package.json",
      "codex-path",
      "codex-resources",
    ]);
    return archivePath;
  }

  function fixture() {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), "nodex-runtime-relock-test-"));
    roots.push(projectRoot);
    const licensePath = path.join(projectRoot, "resources/third-party/codex/LICENSE");
    const noticePath = path.join(projectRoot, "resources/third-party/codex/NOTICE");
    mkdirSync(path.dirname(licensePath), { recursive: true });
    writeFileSync(licensePath, "license\n");
    writeFileSync(noticePath, "notice\n");
    const lock = JSON.parse(
      readFileSync(path.resolve("resources/agent-runtime/codex-app-server.lock.json"), "utf8"),
    ) as CodexAppServerReleaseLock;
    lock.notices.licenseSha256 = sha256("license\n");
    lock.notices.noticeSha256 = sha256("notice\n");
    const arm64ArchivePath = createArchive(
      projectRoot,
      "aarch64-apple-darwin",
      lock.appServerRuntimeVersion,
      lock.requiredArtifacts,
    );
    const manifestBody = `${sha256(readFileSync(arm64ArchivePath))}  ${path.basename(arm64ArchivePath)}\n`;
    writeFileSync(path.join(projectRoot, lock.upstream.checksumManifest.assetName), manifestBody);
    lock.upstream.checksumManifest.sha256 = sha256(manifestBody);
    lock.upstream.checksumManifest.size = Buffer.byteLength(manifestBody);
    const lockPath = path.join(projectRoot, "resources/agent-runtime/codex-app-server.lock.json");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    return {
      lock,
      arm64ArchivePath,
      lockPath,
      projectRoot,
    };
  }

  test.skipIf(process.platform === "win32")(
    "relocks the official archive and produces stageable metadata",
    async () => {
      const input = fixture();
      const candidate = await createAgentRuntimeRelockCandidate({
        ...input,
        agentRuntimePlatformContractVerifier: skipPlatformInspection,
        outputPath: path.join(input.projectRoot, "candidate.json"),
        projectRootPath: input.projectRoot,
      });

      expect(candidate.schemaVersion).toBe(1);
      expect(candidate.upstream).toEqual(input.lock.upstream);
      expect(candidate.builds["darwin-arm64"].archiveSha256).toBe(
        sha256(readFileSync(input.arm64ArchivePath)),
      );
      const unpackedSize = input.lock.requiredArtifacts.reduce(
        (bytes, artifact) =>
          bytes +
          readFileSync(path.join(input.projectRoot, "package-aarch64-apple-darwin", artifact))
            .byteLength,
        0,
      );
      expect(candidate.builds["darwin-arm64"].unpackedSize).toBe(unpackedSize);
      expect(candidate.builds["darwin-arm64"].entrypointSha256).toBe(sha256("#!/bin/sh\nexit 0\n"));
      expect(candidate.builds["darwin-arm64"].runtimeMetadataSha256).not.toBe("0".repeat(64));

      const immutableCandidatePath = path.join(input.projectRoot, "review/candidate.lock.json");
      writeAgentRuntimeRelockCandidate(immutableCandidatePath, candidate);
      expect(() => writeAgentRuntimeRelockCandidate(immutableCandidatePath, candidate)).toThrow();

      const candidatePath = path.join(input.projectRoot, "candidate.lock.json");
      writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
      await expect(
        stageCodexRuntime({
          agentRuntimePlatformContractVerifier: skipPlatformInspection,
          archivePath: input.arm64ArchivePath,
          lockPath: candidatePath,
          outputPath: path.join(input.projectRoot, "verified"),
          projectRootPath: input.projectRoot,
          targetArch: "arm64",
          targetPlatform: "darwin",
        }),
      ).resolves.toMatchObject({
        appServerRuntimeVersion: input.lock.appServerRuntimeVersion,
        targetArch: "arm64",
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "requires explicit archives, base lock, and non-canonical output",
    () => {
      expect(() => parseAgentRuntimeRelockCli(["--out", "/tmp/candidate.json"])).toThrow(
        "official Codex release archive",
      );
      expect(() =>
        parseAgentRuntimeRelockCli([
          "--arm64",
          "/tmp/arm64.tar.gz",
          "--out",
          "/tmp/candidate.json",
        ]),
      ).toThrow("--base-lock is required");
      expect(() =>
        parseAgentRuntimeRelockCli([
          "--arm64",
          "/tmp/arm64.tar.gz",
          "--base-lock",
          "/tmp/base.json",
          "--out",
          path.resolve("resources/agent-runtime/codex-app-server.lock.json"),
        ]),
      ).toThrow("must not overwrite the canonical");
    },
  );
});
