import { ripgrepFixture, writeRipgrepFixture } from "./testing/ripgrep-runtime-fixture";
import workspaceRuntimeLock from "../resources/workspace-runtime/workspace-runtime.lock.json";
import desktopToolsLock from "../resources/browser-runtime/browser-runtime.lock.json";
import {
  packagedStockNodeFixtureOutputs,
  writePackagedStockNodeFixture,
} from "./testing/packaged-stock-node-fixture";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { readCodexAppServerReleaseLock } from "./agent-runtime-release-lock";

import {
  PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION,
  verifyPackagedBuildProvenance,
  writePackagedBuildProvenance,
} from "./package-provenance.mjs";

vi.mock("./ripgrep-runtime-payload.mjs", async (importOriginal) => {
  const { assertRipgrepRuntimePayload } =
    await importOriginal<typeof import("./ripgrep-runtime-payload.mjs")>();
  return {
    assertRipgrepRuntimePayload: (
      ...[directory, target, options]: Parameters<typeof assertRipgrepRuntimePayload>
    ) =>
      assertRipgrepRuntimePayload(directory, target, {
        ...options,
        release: ripgrepFixture(target).release,
      }),
  };
});

const temporaryRoots: string[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const skillFiles = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/markdown.md",
  "references/page-editor.md",
  "references/project-database-views.md",
  "references/queries-and-configuration.md",
  "references/troubleshooting.md",
  "references/visuals.md",
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

const lockPath = path.resolve("resources/agent-runtime/codex-app-server.lock.json");
const lockSha256 = sha256(fs.readFileSync(lockPath, "utf8"));

const makePreparedManifest = (
  agentSkills: { manifestSha256: string; treeSha256: string },
  inputDigest = "1".repeat(64),
): object => {
  const body = {
    agentSkills,
    buildContext: { arch: "arm64", platform: "darwin" },
    codexComponentLockSha256: lockSha256,
    inputDigest,
    outputs: [
      ...packagedStockNodeFixtureOutputs,
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

const { url, archiveSha256, archiveSize, manifestSha256 } = desktopToolsLock.assets["darwin-arm64"];
const desktopToolsPin = { url, archiveSha256, archiveSize, manifestSha256 };

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
    updates: "enabled",
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

const makeApp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-package-provenance-"));
  temporaryRoots.push(root);
  const appPath = path.join(root, "Nodex.app");
  const resources = path.join(appPath, "Contents/Resources");
  fs.mkdirSync(path.join(resources, "bin"), { recursive: true });
  writePackagedStockNodeFixture(resources);
  writeRipgrepFixture(resources, "darwin-arm64");
  writeSparkleRuntime(appPath);
  fs.writeFileSync(path.join(resources, "native/nodex-clipboard.node"), "clipboard bridge", {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(resources, "native/nodex-devicecheck.node"), "devicecheck bridge", {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(resources, "native/nodex-notifications.node"),
    "notifications bridge",
    { mode: 0o755 },
  );
  const agentSkills = writeAgentSkills(resources);
  const prepared = makePreparedManifest(agentSkills);
  writeJson(path.join(resources, "prepared-electron-build.json"), prepared);
  writeJson(path.join(resources, "bin/rust-core-runtime.json"), {
    schemaVersion: 3,
    productVersion: "0.1.10",
    targetPlatform: "darwin",
    targetArch: "arm64",
  });
  const currentPreparedPath = path.join(root, "current-prepared.json");
  writeJson(currentPreparedPath, prepared);
  return { appPath, currentPreparedPath };
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("packaged build provenance", () => {
  test("rejects a bundled Desktop Tools directory when writing or verifying provenance", () => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath);
    fs.mkdirSync(path.join(fixture.appPath, "Contents/Resources/browser-runtime"));
    expect(() => writePackagedBuildProvenance(fixture.appPath)).toThrow(
      "must install Desktop Tools as a Component",
    );
    expect(() => verifyPackagedBuildProvenance(fixture.appPath)).toThrow(
      "must install Desktop Tools as a Component",
    );
  });

  test("binds the Codex archive pin and packaged resources to the prepared source generation", () => {
    const fixture = makeApp();
    const written = writePackagedBuildProvenance(fixture.appPath);

    const verified = verifyPackagedBuildProvenance(fixture.appPath, {
      expectedArch: "arm64",
      expectedPreparedManifestPath: fixture.currentPreparedPath,
    });

    expect(written.schemaVersion).toBe(PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION);
    expect(verified.provenanceId).toBe(written.provenanceId);
    const lock = readCodexAppServerReleaseLock(lockPath);
    const build = lock.builds["darwin-arm64"];
    expect(verified.codex).toEqual({
      url: build.url,
      archiveSha256: build.archiveSha256,
      archiveSize: build.archiveSize,
      assetName: build.assetName,
      metadataSha256: build.runtimeMetadataSha256,
      protocolSchemaFingerprint: lock.protocolSchema.sha256,
      entrypointSha256: build.entrypointSha256,
      lockSha256,
      sourceCommit: lock.upstream.commit,
      signingTeamId: "2DC432GLL2",
      sourceTag: lock.upstream.tag,
      targetTriple: "aarch64-apple-darwin",
      version: lock.appServerRuntimeVersion,
    });
  });

  test("binds the macOS download to the reviewed archive and manifest", () => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath);
    expect(verifyPackagedBuildProvenance(fixture.appPath).desktopTools).toEqual(desktopToolsPin);
  });

  test("binds published Document Tools and rejects an embedded closure", () => {
    const fixture = makeApp();
    const written = writePackagedBuildProvenance(fixture.appPath);
    expect(written.documentTools).toEqual(workspaceRuntimeLock.release.assets["darwin-arm64"]);
    expect(verifyPackagedBuildProvenance(fixture.appPath).documentTools).toEqual(
      written.documentTools,
    );
    fs.mkdirSync(path.join(fixture.appPath, "Contents/Resources/workspace-runtime"));
    expect(() => writePackagedBuildProvenance(fixture.appPath)).toThrow(
      "must not contain Resources/workspace-runtime",
    );
    expect(() => verifyPackagedBuildProvenance(fixture.appPath)).toThrow(
      "must not contain Resources/workspace-runtime",
    );
  });

  test("rejects an untested Browser and app-server artifact pair before sealing provenance", () => {
    const fixture = makeApp();

    expect(() =>
      writePackagedBuildProvenance(fixture.appPath, {
        testedPairs: [],
      }),
    ).toThrow("are not a tested pair");
  });

  test.each([
    ["codex", "Codex"],
    ["desktopTools", "Desktop Tools"],
    ["documentTools", "Document Tools"],
  ] as const)(
    "rejects changes to the %s pin even with self-consistent provenance",
    (key, label) => {
      const fixture = makeApp();
      writePackagedBuildProvenance(fixture.appPath);
      const provenancePath = path.join(
        fixture.appPath,
        "Contents/Resources/nodex-build-provenance.json",
      );
      const { provenanceId: _, ...body } = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
      body[key].archiveSha256 = "a".repeat(64);
      writeJson(provenancePath, { ...body, provenanceId: sha256(stableJson(body)) });

      expect(() => verifyPackagedBuildProvenance(fixture.appPath)).toThrow(
        `${label} provenance differs from the release lock`,
      );
    },
  );

  test("rejects a stale prepared source generation", () => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath);
    const agentSkills = writeAgentSkills(path.join(fixture.appPath, "Contents/Resources"));
    writeJson(fixture.currentPreparedPath, makePreparedManifest(agentSkills, "5".repeat(64)));

    expect(() =>
      verifyPackagedBuildProvenance(fixture.appPath, {
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

    expect(() => writePackagedBuildProvenance(fixture.appPath)).toThrow("targets do not agree");
  });

  test.each([
    "app.asar",
    "agent-runtime/entry.mjs",
    "app-tools/server.mjs",
    "bin/rust-core-runtime.json",
    "native/nodex-sparkle.node",
    "native/nodex-clipboard.node",
    "native/nodex-devicecheck.node",
    "native/nodex-notifications.node",
  ])("rejects a packaged payload mutation in %s", (relativePath) => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath);
    fs.appendFileSync(path.join(fixture.appPath, "Contents/Resources", relativePath), "tampered\n");

    expect(() => verifyPackagedBuildProvenance(fixture.appPath)).toThrow(
      /does not match the packaged provenance|differs from the prepared build/u,
    );
  });

  test("rejects a mutated packaged official Agent Skill", () => {
    const fixture = makeApp();
    writePackagedBuildProvenance(fixture.appPath);
    fs.appendFileSync(
      path.join(fixture.appPath, "Contents/Resources/agent-skills/skills/nodex/SKILL.md"),
      "tampered\n",
    );

    expect(() => verifyPackagedBuildProvenance(fixture.appPath)).toThrow(
      "tree does not match its release manifest",
    );
  });

  test("rejects an embedded Codex file when writing or verifying provenance", () => {
    const { appPath } = makeApp();
    writePackagedBuildProvenance(appPath);
    fs.writeFileSync(path.join(appPath, "Contents/Resources/bin/codex"), "legacy runtime");
    expect(() => writePackagedBuildProvenance(appPath)).toThrow(
      "must install Codex as a Component",
    );
    expect(() => verifyPackagedBuildProvenance(appPath)).toThrow(
      "must install Codex as a Component",
    );
  });

  test("rejects a prepared build that recorded a different Codex lock", () => {
    const { appPath } = makeApp();
    const manifestPath = path.join(appPath, "Contents/Resources/prepared-electron-build.json");
    const { generationId: _, ...body } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    body.codexComponentLockSha256 = "b".repeat(64);
    writeJson(manifestPath, { ...body, generationId: sha256(JSON.stringify(body)) });
    expect(() => writePackagedBuildProvenance(appPath)).toThrow(
      "pins a different Codex release lock",
    );
  });
});
