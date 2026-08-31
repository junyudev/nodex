export const CODEX_APP_SERVER_REQUIRED_ARTIFACTS = Object.freeze([
  "codex-package.json",
  "bin/codex-app-server",
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/zsh/bin/zsh",
]);

export const OFFICIAL_CODEX_MACOS_SIGNING_TEAM_ID = "2DC432GLL2";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const TARGETS = ["darwin-arm64", "darwin-x64"];
const TARGET_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, expected) =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

const string = (value, label) => {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Invalid Codex app-server release lock ${label}`);
};

const sha = (value, label) => {
  const parsed = string(value, label);
  if (SHA256.test(parsed)) return parsed;
  throw new Error(`Invalid Codex app-server release lock ${label}`);
};

const positiveInteger = (value, label) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(`Invalid Codex app-server release lock ${label}`);
};

const relativePath = (value, label) => {
  const parsed = string(value, label);
  if (
    !parsed.startsWith("/") &&
    !parsed.includes("\\") &&
    parsed.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  ) {
    return parsed;
  }
  throw new Error(`Invalid Codex app-server release lock ${label}`);
};

const targetMap = (value, label, parse) => {
  if (!isObject(value) || !hasExactKeys(value, TARGETS)) {
    throw new Error(`${label} must contain exactly darwin-arm64 and darwin-x64`);
  }
  return {
    "darwin-arm64": parse(value["darwin-arm64"], `${label}.darwin-arm64`, "darwin-arm64"),
    "darwin-x64": parse(value["darwin-x64"], `${label}.darwin-x64`, "darwin-x64"),
  };
};

const officialAsset = ({ label, repository, tag, value }) => {
  if (!isObject(value)) {
    throw new Error(`Invalid Codex app-server release lock ${label}`);
  }
  const assetName = string(value.assetName, `${label}.assetName`);
  if (assetName.includes("/") || assetName.includes("\\")) {
    throw new Error(`Invalid Codex app-server release lock ${label}.assetName`);
  }
  const url = string(value.url, `${label}.url`);
  const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
  if (url !== expectedUrl) {
    throw new Error(`${label}.url does not match the locked official Codex release`);
  }
  return {
    archiveSha256: sha(value.archiveSha256, `${label}.archiveSha256`),
    archiveSize: positiveInteger(value.archiveSize, `${label}.archiveSize`),
    assetName,
    url,
  };
};

/** Strictly decodes the complete canonical Nodex lock for official Codex release artifacts. */
export function parseCodexAppServerReleaseLock(value) {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.runtimeFamily !== "codex-app-server" ||
    !hasExactKeys(value, [
      "appServerRuntimeVersion",
      "builds",
      "notices",
      "packageManifest",
      "protocolSchema",
      "requiredArtifacts",
      "runtimeFamily",
      "schemaVersion",
      "upstream",
    ])
  ) {
    throw new Error("Invalid Codex app-server release lock header");
  }

  const appServerRuntimeVersion = string(value.appServerRuntimeVersion, "appServerRuntimeVersion");
  if (
    !isObject(value.upstream) ||
    !hasExactKeys(value.upstream, [
      "checksumManifest",
      "commit",
      "repository",
      "signingTeamId",
      "tag",
    ])
  ) {
    throw new Error("Invalid Codex app-server release lock upstream");
  }
  if (value.upstream.repository !== "openai/codex") {
    throw new Error("Invalid Codex app-server release lock upstream.repository");
  }
  if (value.upstream.signingTeamId !== OFFICIAL_CODEX_MACOS_SIGNING_TEAM_ID) {
    throw new Error("Invalid Codex app-server release lock upstream.signingTeamId");
  }
  const upstreamTag = string(value.upstream.tag, "upstream.tag");
  if (upstreamTag !== `rust-v${appServerRuntimeVersion}`) {
    throw new Error(`Codex upstream tag must be rust-v${appServerRuntimeVersion}`);
  }
  const upstreamCommit = string(value.upstream.commit, "upstream.commit");
  if (!COMMIT.test(upstreamCommit)) {
    throw new Error("Invalid Codex app-server release lock upstream.commit");
  }
  if (
    !isObject(value.upstream.checksumManifest) ||
    !hasExactKeys(value.upstream.checksumManifest, ["assetName", "sha256", "size", "url"])
  ) {
    throw new Error("Invalid Codex app-server release lock upstream.checksumManifest");
  }
  const checksumAssetName = string(
    value.upstream.checksumManifest.assetName,
    "upstream.checksumManifest.assetName",
  );
  if (checksumAssetName !== "codex-package_SHA256SUMS") {
    throw new Error("Invalid Codex app-server release lock upstream.checksumManifest.assetName");
  }
  const checksumUrl = string(value.upstream.checksumManifest.url, "upstream.checksumManifest.url");
  if (
    checksumUrl !==
    `https://github.com/openai/codex/releases/download/${upstreamTag}/${checksumAssetName}`
  ) {
    throw new Error(
      "upstream.checksumManifest.url does not match the locked official Codex release",
    );
  }

  const builds = targetMap(value.builds, "builds", (entry, label, key) => {
    if (
      !isObject(entry) ||
      !hasExactKeys(entry, [
        "archiveSha256",
        "archiveSize",
        "assetName",
        "entrypointSha256",
        "runtimeMetadataSha256",
        "targetTriple",
        "url",
      ])
    ) {
      throw new Error(`Invalid Codex app-server release lock ${label}`);
    }
    const asset = officialAsset({
      label,
      repository: "openai/codex",
      tag: upstreamTag,
      value: entry,
    });
    const targetTriple = string(entry.targetTriple, `${label}.targetTriple`);
    if (targetTriple !== TARGET_TRIPLES[key]) {
      throw new Error(`Invalid Codex app-server release lock ${label}.targetTriple`);
    }
    if (asset.assetName !== `codex-app-server-package-${targetTriple}.tar.gz`) {
      throw new Error(`Codex app-server release asset name differs from runtime build ${key}`);
    }
    return {
      ...asset,
      entrypointSha256: sha(entry.entrypointSha256, `${label}.entrypointSha256`),
      runtimeMetadataSha256: sha(entry.runtimeMetadataSha256, `${label}.runtimeMetadataSha256`),
      targetTriple,
    };
  });

  if (
    !isObject(value.protocolSchema) ||
    value.protocolSchema.experimental !== true ||
    !hasExactKeys(value.protocolSchema, ["experimental", "sha256", "tools"])
  ) {
    throw new Error("Invalid Codex protocolSchema");
  }
  const schemaTools = targetMap(
    value.protocolSchema.tools,
    "protocolSchema.tools",
    (entry, label, key) => {
      if (
        !isObject(entry) ||
        !hasExactKeys(entry, [
          "archiveSha256",
          "archiveSize",
          "assetName",
          "entrypoint",
          "targetTriple",
          "url",
        ])
      ) {
        throw new Error(`Invalid Codex app-server release lock ${label}`);
      }
      const asset = officialAsset({
        label,
        repository: "openai/codex",
        tag: upstreamTag,
        value: entry,
      });
      const targetTriple = string(entry.targetTriple, `${label}.targetTriple`);
      if (targetTriple !== TARGET_TRIPLES[key]) {
        throw new Error(`Invalid Codex app-server release lock ${label}.targetTriple`);
      }
      const expectedAssetName = `codex-${targetTriple}.tar.gz`;
      if (asset.assetName !== expectedAssetName) {
        throw new Error(`Codex schema tool asset name differs from runtime target ${key}`);
      }
      const entrypoint = relativePath(entry.entrypoint, `${label}.entrypoint`);
      if (entrypoint !== `codex-${targetTriple}`) {
        throw new Error(`Codex schema tool entrypoint differs from runtime target ${key}`);
      }
      return {
        ...asset,
        entrypoint,
        targetTriple,
      };
    },
  );

  if (
    !isObject(value.packageManifest) ||
    value.packageManifest.variant !== "codex-app-server" ||
    !hasExactKeys(value.packageManifest, [
      "entrypoint",
      "layoutVersion",
      "pathDir",
      "resourcesDir",
      "variant",
      "version",
    ])
  ) {
    throw new Error("Invalid Codex packageManifest");
  }
  const packageVersion = string(value.packageManifest.version, "packageManifest.version");
  if (packageVersion !== appServerRuntimeVersion) {
    throw new Error("Codex runtime and package versions differ");
  }
  const entrypoint = relativePath(value.packageManifest.entrypoint, "packageManifest.entrypoint");
  if (entrypoint !== "bin/codex-app-server") {
    throw new Error("Codex package entrypoint must be bin/codex-app-server");
  }
  const packageLayoutVersion = positiveInteger(
    value.packageManifest.layoutVersion,
    "packageManifest.layoutVersion",
  );
  const packagePathDir = relativePath(value.packageManifest.pathDir, "packageManifest.pathDir");
  const packageResourcesDir = relativePath(
    value.packageManifest.resourcesDir,
    "packageManifest.resourcesDir",
  );
  if (
    packageLayoutVersion !== 1 ||
    packagePathDir !== "codex-path" ||
    packageResourcesDir !== "codex-resources"
  ) {
    throw new Error("Codex package manifest layout differs from the canonical release package");
  }

  if (!Array.isArray(value.requiredArtifacts)) {
    throw new Error("Invalid Codex requiredArtifacts");
  }
  const requiredArtifacts = value.requiredArtifacts.map((entry, index) =>
    relativePath(entry, `requiredArtifacts[${index}]`),
  );
  if (JSON.stringify(requiredArtifacts) !== JSON.stringify(CODEX_APP_SERVER_REQUIRED_ARTIFACTS)) {
    throw new Error("Codex requiredArtifacts must equal the canonical ordered package closure");
  }
  if (
    !isObject(value.notices) ||
    !hasExactKeys(value.notices, ["licensePath", "licenseSha256", "noticePath", "noticeSha256"])
  ) {
    throw new Error("Invalid Codex notices");
  }
  const licensePath = relativePath(value.notices.licensePath, "notices.licensePath");
  const noticePath = relativePath(value.notices.noticePath, "notices.noticePath");
  if (
    licensePath !== "resources/third-party/codex/LICENSE" ||
    noticePath !== "resources/third-party/codex/NOTICE"
  ) {
    throw new Error("Codex notice paths differ from the canonical legal closure");
  }

  return {
    appServerRuntimeVersion,
    builds,
    notices: {
      licensePath,
      licenseSha256: sha(value.notices.licenseSha256, "notices.licenseSha256"),
      noticePath,
      noticeSha256: sha(value.notices.noticeSha256, "notices.noticeSha256"),
    },
    packageManifest: {
      entrypoint,
      layoutVersion: packageLayoutVersion,
      pathDir: packagePathDir,
      resourcesDir: packageResourcesDir,
      variant: "codex-app-server",
      version: packageVersion,
    },
    protocolSchema: {
      experimental: true,
      sha256: sha(value.protocolSchema.sha256, "protocolSchema.sha256"),
      tools: schemaTools,
    },
    requiredArtifacts,
    runtimeFamily: "codex-app-server",
    schemaVersion: 1,
    upstream: {
      checksumManifest: {
        assetName: checksumAssetName,
        sha256: sha(value.upstream.checksumManifest.sha256, "upstream.checksumManifest.sha256"),
        size: positiveInteger(
          value.upstream.checksumManifest.size,
          "upstream.checksumManifest.size",
        ),
        url: checksumUrl,
      },
      commit: upstreamCommit,
      repository: "openai/codex",
      signingTeamId: OFFICIAL_CODEX_MACOS_SIGNING_TEAM_ID,
      tag: upstreamTag,
    },
  };
}
