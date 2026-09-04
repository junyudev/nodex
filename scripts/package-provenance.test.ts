import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  projectBrowserPeerRuntimeIdentity,
  projectBundledAppServerRuntimeIdentity,
  type TestedBrowserAppServerPair,
} from "../src/shared/browser-app-server-compatibility";

import {
  verifyPackagedBuildProvenance,
  writePackagedBuildProvenance,
} from "./package-provenance.mjs";

const temporaryRoots: string[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const skillFiles = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/nested-markdown.md",
  "references/page-editor.md",
  "references/project-database-views.md",
  "references/troubleshooting.md",
] as const;

const writeAgentSkills = (resources: string): { manifestSha256: string; treeSha256: string } => {
  const root = path.join(resources, "agent-skills");
  const files = new Map(
    skillFiles.map((relativePath) => [relativePath, Buffer.from(`${relativePath}\n`, "utf8")]),
  );
  const hash = createHash("sha256");
  for (const relativePath of [...files.keys()].sort()) {
    const contents = files.get(relativePath);
    if (!contents) throw new Error(`Missing test Skill file: ${relativePath}`);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  const treeSha256 = hash.digest("hex");
  for (const [relativePath, contents] of files) {
    const destination = path.join(root, "skills/nodex", relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  fs.writeFileSync(path.join(root, "README.md"), "README\n");
  fs.writeFileSync(path.join(root, "LICENSE"), "LICENSE\n");
  const manifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      distribution: "NodexApp/skills",
      product: { name: "Nodex", releaseVersion: "0.1.10" },
      source: { repository: "NodexApp/nodex", ref: "v0.1.10" },
      agentInterface: { minimumRevision: 1, maximumRevision: 1 },
      skills: [
        {
          name: "nodex",
          path: "skills/nodex",
          treeSha256,
          fileCount: files.size,
          totalBytes: [...files.values()].reduce(
            (total, contents) => total + contents.byteLength,
            0,
          ),
        },
      ],
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(path.join(root, "release-manifest.json"), manifest);
  return { manifestSha256: sha256(manifest), treeSha256 };
};

const makePreparedManifest = (
  agentSkills: { manifestSha256: string; treeSha256: string },
  inputDigest = "1".repeat(64),
): object => {
  const body = {
    agentSkills,
    buildContext: { arch: "arm64", platform: "darwin" },
    inputDigest,
    outputs: [
      {
        executable: false,
        path: "out/main/bootstrap.js",
        sha256: "2".repeat(64),
        size: 10,
      },
    ],
    product: { name: "nodex", version: "0.1.10" },
    releaseIdentity: null,
    schemaVersion: 4,
    source: {
      baseCommit: "3".repeat(40),
      baseTree: "4".repeat(40),
      snapshotDigest: inputDigest,
      state: "clean",
    },
  };
  return {
    ...body,
    generationId: sha256(JSON.stringify(body)),
  };
};

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeBrowserManifest = (appPath: string, peerCliVersion = "0.150.0-alpha.12.2"): string => {
  const browserManifestPath = path.join(
    appPath,
    "Contents/Resources/browser-runtime/browser-runtime-manifest.json",
  );
  writeJson(browserManifestPath, {
    browserPlugin: { version: "26.825.32147" },
    runtimeVersions: { codexCli: peerCliVersion },
    schemaVersion: 5,
    targetArch: "arm64",
    targetPlatform: "darwin",
  });
  return browserManifestPath;
};

const packagedRuntimePair = (appPath: string): TestedBrowserAppServerPair => {
  const resources = path.join(appPath, "Contents/Resources");
  const agentManifest = JSON.parse(
    fs.readFileSync(path.join(resources, "agent-runtime.json"), "utf8"),
  ) as Parameters<typeof projectBundledAppServerRuntimeIdentity>[0];
  const browserManifestPath = path.join(resources, "browser-runtime/browser-runtime-manifest.json");
  const browserManifest = JSON.parse(fs.readFileSync(browserManifestPath, "utf8")) as Parameters<
    typeof projectBrowserPeerRuntimeIdentity
  >[0];
  return {
    appServer: projectBundledAppServerRuntimeIdentity(agentManifest),
    browser: projectBrowserPeerRuntimeIdentity(
      browserManifest,
      sha256(fs.readFileSync(browserManifestPath, "utf8")),
    ),
  };
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const refreshBrowserProvenanceIdentity = (appPath: string): void => {
  const browserManifestPath = path.join(
    appPath,
    "Contents/Resources/browser-runtime/browser-runtime-manifest.json",
  );
  const browserContents = fs.readFileSync(browserManifestPath);
  const provenancePath = path.join(appPath, "Contents/Resources/nodex-build-provenance.json");
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8")) as {
    payload: { browserRuntimeManifest: unknown };
    provenanceId?: string;
    [key: string]: unknown;
  };
  provenance.payload.browserRuntimeManifest = {
    path: "browser-runtime/browser-runtime-manifest.json",
    sha256: sha256(browserContents.toString("utf8")),
    size: browserContents.byteLength,
  };
  delete provenance.provenanceId;
  provenance.provenanceId = sha256(stableJson(provenance));
  writeJson(provenancePath, provenance);
};

const refreshAgentRuntimeProvenanceIdentity = (appPath: string): void => {
  const resources = path.join(appPath, "Contents/Resources");
  const manifestPath = path.join(resources, "agent-runtime.json");
  const manifestContents = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestContents.toString("utf8")) as unknown;
  const provenancePath = path.join(resources, "nodex-build-provenance.json");
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8")) as {
    agentRuntime: { metadataSha256: string };
    payload: { agentRuntimeManifest: unknown };
    provenanceId?: string;
    [key: string]: unknown;
  };
  provenance.agentRuntime.metadataSha256 = sha256(stableJson(manifest));
  provenance.payload.agentRuntimeManifest = {
    path: "agent-runtime.json",
    sha256: sha256(manifestContents.toString("utf8")),
    size: manifestContents.byteLength,
  };
  delete provenance.provenanceId;
  provenance.provenanceId = sha256(stableJson(provenance));
  writeJson(provenancePath, provenance);
};

const writeSparkleRuntime = (appPath: string): void => {
  const artifactPaths = {
    autoupdate: "Frameworks/Sparkle.framework/Versions/B/Autoupdate",
    bridge: "Resources/native/nodex-sparkle.node",
    frameworkExecutable: "Frameworks/Sparkle.framework/Versions/B/Sparkle",
    frameworkInfoPlist: "Frameworks/Sparkle.framework/Versions/B/Resources/Info.plist",
    updater: "Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater",
  };
  const artifacts = Object.fromEntries(
    Object.entries(artifactPaths).map(([name, relativePath]) => {
      const filePath = path.join(appPath, "Contents", relativePath);
      const contents = Buffer.from(`${name}\n`, "utf8");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, { mode: name === "frameworkInfoPlist" ? 0o644 : 0o755 });
      return [
        name,
        {
          path: relativePath,
          sha256: createHash("sha256").update(contents).digest("hex"),
          size: contents.length,
        },
      ];
    }),
  );
  writeJson(path.join(appPath, "Contents/Resources/native/sparkle-runtime.json"), {
    artifacts,
    architecture: "arm64",
    buildChannel: "stable",
    feedUrls: {
      stable: "https://nodex.jyu.app/updates/stable/arm64/appcast.xml",
      nightly: "https://nodex.jyu.app/updates/nightly/arm64/appcast.xml",
    },
    minimumMacOS: "15.0",
    publicKey: "YNySLZ74gjVAOpEdMo9OOEPvuTEMZf8fMnI+oQD7Ifs=",
    schemaVersion: 3,
    sparkleArchiveSha256: "6".repeat(64),
    sparkleVersion: "2.9.4",
  });
};

const writeAgentRuntime = (root: string, resources: string): string => {
  const canonicalLockPath = path.resolve("resources/agent-runtime/codex-app-server.lock.json");
  const lock = JSON.parse(fs.readFileSync(canonicalLockPath, "utf8")) as {
    builds: Record<
      "darwin-arm64" | "darwin-x64",
      {
        archiveSha256: string;
        archiveSize: number;
        assetName: string;
        entrypointSha256: string;
        runtimeMetadataSha256: string;
        targetTriple: string;
      }
    >;
    packageManifest: {
      entrypoint: string;
      layoutVersion: number;
      pathDir: string;
      resourcesDir: string;
      variant: "codex-app-server";
      version: string;
    };
    protocolSchema: { sha256: string };
    upstream: {
      commit: string;
      repository: "openai/codex";
      tag: string;
    };
  };
  const build = lock.builds["darwin-arm64"];
  const packageManifest = {
    ...lock.packageManifest,
    target: build.targetTriple,
  };
  const files = new Map<string, { contents: Buffer; executable: boolean }>([
    [
      "codex-package.json",
      { contents: Buffer.from(`${JSON.stringify(packageManifest)}\n`), executable: false },
    ],
    ["bin/codex-app-server", { contents: Buffer.from("app-server\n"), executable: true }],
    ["bin/codex-code-mode-host", { contents: Buffer.from("code-mode\n"), executable: true }],
    ["codex-path/rg", { contents: Buffer.from("ripgrep\n"), executable: true }],
    ["codex-resources/zsh/bin/zsh", { contents: Buffer.from("zsh\n"), executable: true }],
    ["third-party/codex/LICENSE", { contents: Buffer.from("license\n"), executable: false }],
    ["third-party/codex/NOTICE", { contents: Buffer.from("notice\n"), executable: false }],
  ]);
  const artifacts = [...files].map(([relativePath, file]) => {
    const destination = path.join(resources, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.contents, { mode: file.executable ? 0o755 : 0o644 });
    return {
      executable: file.executable,
      path: relativePath,
      sha256: createHash("sha256").update(file.contents).digest("hex"),
      size: file.contents.byteLength,
    };
  });
  const entrypoint = artifacts.find(
    ({ path: artifactPath }) => artifactPath === packageManifest.entrypoint,
  );
  if (!entrypoint) throw new Error("Missing test app-server entrypoint");
  build.archiveSha256 = sha256("fixture archive");
  build.archiveSize = Buffer.byteLength("fixture archive");
  build.entrypointSha256 = entrypoint.sha256;
  const metadata = {
    appServerRuntimeVersion: lock.packageManifest.version,
    artifacts,
    entrypoint: packageManifest.entrypoint,
    layoutVersion: 4,
    packageManifest,
    protocolSchemaFingerprint: lock.protocolSchema.sha256,
    releaseAsset: {
      archiveSha256: build.archiveSha256,
      archiveSize: build.archiveSize,
      assetName: build.assetName,
      entrypointSha256: entrypoint.sha256,
      repository: lock.upstream.repository,
      tag: lock.upstream.tag,
    },
    runtimeFamily: "codex-app-server",
    searchPaths: [packageManifest.pathDir],
    sourceRevision: {
      commit: lock.upstream.commit,
      repository: lock.upstream.repository,
      tag: lock.upstream.tag,
    },
    targetArch: "arm64",
    targetPlatform: "darwin",
    targetTriple: build.targetTriple,
  };
  build.runtimeMetadataSha256 = sha256(stableJson(metadata));
  writeJson(path.join(resources, "agent-runtime.json"), metadata);
  const lockPath = path.join(root, "codex-app-server.lock.json");
  writeJson(lockPath, lock);
  return lockPath;
};

const makeApp = (
  options: { includeBrowser?: boolean } = {},
): {
  appPath: string;
  currentPreparedPath: string;
  lockPath: string;
  testedPairs: readonly TestedBrowserAppServerPair[];
} => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-package-provenance-"));
  temporaryRoots.push(root);
  const appPath = path.join(root, "Nodex.app");
  const resources = path.join(appPath, "Contents/Resources");
  fs.mkdirSync(path.join(resources, "bin"), { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), "current app payload\n");
  writeSparkleRuntime(appPath);
  fs.writeFileSync(path.join(resources, "native/nodex-clipboard.node"), "clipboard bridge", {
    mode: 0o755,
  });
  const agentSkills = writeAgentSkills(resources);
  const prepared = makePreparedManifest(agentSkills);
  writeJson(path.join(resources, "prepared-electron-build.json"), prepared);
  writeJson(path.join(resources, "bin/rust-core-runtime.json"), {
    schemaVersion: 3,
    productVersion: "0.1.10",
    targetPlatform: "darwin",
    targetArch: "arm64",
  });
  const lockPath = writeAgentRuntime(root, resources);
  if (options.includeBrowser !== false) writeBrowserManifest(appPath);
  const testedPairs = options.includeBrowser === false ? [] : [packagedRuntimePair(appPath)];
  const currentPreparedPath = path.join(root, "current-prepared.json");
  writeJson(currentPreparedPath, prepared);
  return { appPath, currentPreparedPath, lockPath, testedPairs };
};

const provenanceOptions = (fixture: ReturnType<typeof makeApp>) => ({
  testedPairs: fixture.testedPairs,
  testOnlyAgentRuntimeLockPath: fixture.lockPath,
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("packaged build provenance", () => {
  test("requires Browser runtime closure for production provenance", () => {
    const fixture = makeApp({ includeBrowser: false });

    expect(() => writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture))).toThrow(
      "Browser runtime manifest is required",
    );
  });

  test("rejects the synthetic lock injection outside Vitest", () => {
    const fixture = makeApp();
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() =>
        writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture)),
      ).toThrow("available only to the Vitest harness");
    } finally {
      if (vitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = vitest;
    }
  });

  test("binds app.asar and both runtime manifests to the prepared source generation", () => {
    const fixture = makeApp();
    const written = writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture));

    const verified = verifyPackagedBuildProvenance(fixture.appPath, {
      ...provenanceOptions(fixture),
      expectedArch: "arm64",
      expectedPreparedManifestPath: fixture.currentPreparedPath,
    });

    expect(verified.provenanceId).toBe(written.provenanceId);
    expect(verified.agentRuntime).toMatchObject({
      lockSha256: sha256(fs.readFileSync(fixture.lockPath, "utf8")),
      signingTeamId: "2DC432GLL2",
      sourceTag: "rust-v0.152.0",
      targetTriple: "aarch64-apple-darwin",
      version: "0.152.0",
    });
  });

  test("binds the required Browser runtime manifest", () => {
    const fixture = makeApp();
    const browserManifestPath = path.join(
      fixture.appPath,
      "Contents/Resources/browser-runtime/browser-runtime-manifest.json",
    );
    writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture));
    fs.appendFileSync(browserManifestPath, "tampered\n");

    expect(() =>
      verifyPackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture)),
    ).toThrow("does not match the packaged provenance");
  });

  test("rejects an untested Browser and app-server artifact pair before sealing provenance", () => {
    const fixture = makeApp();

    expect(() =>
      writePackagedBuildProvenance(fixture.appPath, {
        testOnlyAgentRuntimeLockPath: fixture.lockPath,
      }),
    ).toThrow("targets do not agree");
  });

  test("rejects Browser artifact identity drift during verification", () => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture));
    writeBrowserManifest(fixture.appPath, "0.149.0");
    refreshBrowserProvenanceIdentity(fixture.appPath);

    expect(() =>
      verifyPackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture)),
    ).toThrow("target does not match provenance");
  });

  test("rejects a stale prepared source generation", () => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture));
    const agentSkills = writeAgentSkills(path.join(fixture.appPath, "Contents/Resources"));
    writeJson(fixture.currentPreparedPath, makePreparedManifest(agentSkills, "5".repeat(64)));

    expect(() =>
      verifyPackagedBuildProvenance(fixture.appPath, {
        ...provenanceOptions(fixture),
        expectedPreparedManifestPath: fixture.currentPreparedPath,
      }),
    ).toThrow("stale for the current prepared Electron source");
  });

  test("rejects native/app version drift before sealing provenance", () => {
    const fixture = makeApp();
    const nativeManifestPath = path.join(
      fixture.appPath,
      "Contents/Resources/bin/rust-core-runtime.json",
    );
    writeJson(nativeManifestPath, {
      schemaVersion: 3,
      productVersion: "0.2.0",
      targetPlatform: "darwin",
      targetArch: "arm64",
    });

    expect(() => writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture))).toThrow(
      "targets do not agree",
    );
  });

  test.each([
    "app.asar",
    "bin/rust-core-runtime.json",
    "agent-runtime.json",
    "native/nodex-sparkle.node",
    "native/nodex-clipboard.node",
  ])("rejects a packaged payload mutation in %s", (relativePath) => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture));
    fs.appendFileSync(path.join(fixture.appPath, "Contents/Resources", relativePath), "tampered\n");

    expect(() =>
      verifyPackagedBuildProvenance(fixture.appPath, {
        ...provenanceOptions(fixture),
      }),
    ).toThrow("does not match the packaged provenance");
  });

  test("rejects a mutated packaged official Agent Skill", () => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture));
    fs.appendFileSync(
      path.join(fixture.appPath, "Contents/Resources/agent-skills/skills/nodex/SKILL.md"),
      "tampered\n",
    );

    expect(() =>
      verifyPackagedBuildProvenance(fixture.appPath, {
        ...provenanceOptions(fixture),
      }),
    ).toThrow("tree does not match its release manifest");
  });

  test("rejects an incomplete Agent runtime manifest even when a test lock repeats its digest", () => {
    const fixture = makeApp();
    const manifestPath = path.join(fixture.appPath, "Contents/Resources/agent-runtime.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.searchPaths;
    writeJson(manifestPath, manifest);
    const lock = JSON.parse(fs.readFileSync(fixture.lockPath, "utf8")) as {
      builds: { "darwin-arm64": { runtimeMetadataSha256: string } };
    };
    lock.builds["darwin-arm64"].runtimeMetadataSha256 = sha256(stableJson(manifest));
    writeJson(fixture.lockPath, lock);

    expect(() => writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture))).toThrow(
      "invalid or incomplete",
    );
  });

  test("rejects a self-consistent Agent artifact reseal that is absent from the canonical lock", () => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture));
    const resources = path.join(fixture.appPath, "Contents/Resources");
    const artifactPath = path.join(resources, "codex-path/rg");
    fs.writeFileSync(artifactPath, "tampered ripgrep\n", { mode: 0o755 });
    const manifestPath = path.join(resources, "agent-runtime.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      artifacts: Array<{ path: string; sha256: string; size: number }>;
    };
    const artifact = manifest.artifacts.find(
      ({ path: relativePath }) => relativePath === "codex-path/rg",
    );
    if (!artifact) throw new Error("Missing test ripgrep artifact");
    const artifactContents = fs.readFileSync(artifactPath);
    artifact.sha256 = createHash("sha256").update(artifactContents).digest("hex");
    artifact.size = artifactContents.byteLength;
    writeJson(manifestPath, manifest);
    refreshAgentRuntimeProvenanceIdentity(fixture.appPath);

    expect(() =>
      verifyPackagedBuildProvenance(fixture.appPath, provenanceOptions(fixture)),
    ).toThrow("canonical release lock");
  });
});
