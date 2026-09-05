import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  CODEX_APP_SERVER_REQUIRED_ARTIFACTS,
  parseCodexAppServerReleaseLock,
  readCodexAppServerReleaseLock,
} from "./agent-runtime-release-lock";

const HASH = "a".repeat(64);
const COMMIT = "316795b3cf2a45e90d121d9f46499d4658b2645c";
const TAG = "rust-v0.152.0";
const releaseUrl = (assetName: string) =>
  `https://github.com/openai/codex/releases/download/${TAG}/${assetName}`;

function makeLock(): Record<string, unknown> {
  const build = (targetTriple: string) => {
    const assetName = `codex-app-server-package-${targetTriple}.tar.gz`;
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
      "darwin-x64": build("x86_64-apple-darwin"),
    },
    notices: {
      licensePath: "resources/third-party/codex/LICENSE",
      licenseSha256: HASH,
      noticePath: "resources/third-party/codex/NOTICE",
      noticeSha256: HASH,
    },
    packageManifest: {
      entrypoint: "bin/codex-app-server",
      layoutVersion: 1,
      pathDir: "codex-path",
      resourcesDir: "codex-resources",
      variant: "codex-app-server",
      version: "0.152.0",
    },
    protocolSchema: {
      experimental: true,
      sha256: HASH,
      tools: {
        "darwin-arm64": schemaTool("aarch64-apple-darwin"),
        "darwin-x64": schemaTool("x86_64-apple-darwin"),
      },
    },
    requiredArtifacts: [...CODEX_APP_SERVER_REQUIRED_ARTIFACTS],
    runtimeFamily: "codex-app-server",
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
    releaseUrl("codex-app-server-package-aarch64-apple-darwin.tar.gz"),
  );
  expect(lock.upstream.checksumManifest.url).toBe(releaseUrl("codex-package_SHA256SUMS"));
});

test("accepts the canonical no-patch runtime lock", () => {
  const lock = readCodexAppServerReleaseLock(
    resolve("resources/agent-runtime/codex-app-server.lock.json"),
  );
  expect(lock.schemaVersion).toBe(1);
  expect(lock.requiredArtifacts).toEqual(CODEX_APP_SERVER_REQUIRED_ARTIFACTS);
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

test("requires exact supported targets and canonical closure", () => {
  const extraTarget = makeLock();
  const builds = extraTarget.builds as Record<string, unknown>;
  builds["darwin-arm64-debug"] = builds["darwin-arm64"];
  expect(() => parseCodexAppServerReleaseLock(extraTarget)).toThrow(
    "exactly darwin-arm64 and darwin-x64",
  );

  const missingArtifact = makeLock();
  missingArtifact.requiredArtifacts = CODEX_APP_SERVER_REQUIRED_ARTIFACTS.slice(0, -1);
  expect(() => parseCodexAppServerReleaseLock(missingArtifact)).toThrow(
    "canonical ordered package closure",
  );

  const packageLayoutDrift = makeLock();
  (packageLayoutDrift.packageManifest as Record<string, unknown>).pathDir = "bin";
  expect(() => parseCodexAppServerReleaseLock(packageLayoutDrift)).toThrow(
    "canonical release package",
  );

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
  entrypointTools["darwin-x64"]!.entrypoint = "codex";
  expect(() => parseCodexAppServerReleaseLock(wrongEntrypoint)).toThrow("schema tool entrypoint");
});
