import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION } from "../package-provenance.mjs";
import {
  assembleReleaseBundle,
  parseArchitectureBuildManifest,
  parseReleaseBundleManifest,
  parseReleaseHistoryBundle,
  type ArchitectureBuildManifest,
  type MacArchitecture,
} from "./bundle";
import { readPublishedReleaseIndex, releaseAssetPaths } from "./github-release";
import { buildIdentityOf, sha256File } from "./model";
import { appComponentManifestName } from "../../src/shared/app-component-manifest";
import { macComponentManifest } from "./components";
import {
  NODEX_MACOS_TEAM_IDENTIFIER,
  type SparkleArchitectureUpdateManifest,
} from "./sparkle-manifest";

import { makeMobileBuild, makeMobileReleaseFixture } from "./mobile-release.fixture";
import { fixtureIdentity, makeWindowsReleaseFixture } from "./windows-release.fixture";

let fixture = "";
let windows: ReturnType<typeof makeWindowsReleaseFixture> &
  ReturnType<typeof makeMobileReleaseFixture>;
const VERSION = "0.2.2";
const PREVIOUS_VERSION = "0.2.1";
const BUILD_VERSION = "1.0.1";
const SOURCE_SHA = "1".repeat(40);
const SIGNATURE = `${"A".repeat(86)}==`;

const makeArchitecture = (architecture: MacArchitecture, sourceSha = SOURCE_SHA): string => {
  const root = join(fixture, `architecture-${architecture}`);
  mkdirSync(root);
  const artifactSpecs = [
    [`Nodex-${VERSION}-${architecture}.dmg`, "dmg"],
    [`Nodex-${VERSION}-${architecture}.tar.xz`, "sparkle-full"],
    [appComponentManifestName(VERSION, "darwin-arm64"), "components-manifest"],
  ] as const;
  const artifacts = artifactSpecs.map(([name, role]) => {
    const filePath = join(root, name);
    writeFileSync(
      filePath,
      role === "components-manifest"
        ? JSON.stringify(macComponentManifest(fixtureIdentity()))
        : `${architecture}:${name}`,
    );
    return {
      architecture,
      bytes: readFileSync(filePath).byteLength,
      name,
      role,
      sha256: sha256File(filePath),
    };
  });
  const manifest: ArchitectureBuildManifest = {
    agentSkills: { manifestSha256: "9".repeat(64), treeSha256: "a".repeat(64) },
    architecture,
    artifacts,
    packageProvenanceSha256: "2".repeat(64),
    preparedBuild: {
      generation: "7".repeat(64),
      manifestSha256: "3".repeat(64),
      state: "clean",
    },
    runner: { image: "test" },
    runtimeLocks: {
      agentSha256: "4".repeat(64),
      browserSha256: "5".repeat(64),
      sparkleSha256: "b".repeat(64),
    },
    schemaVersion: 3,
    updates: "enabled",
    buildIdentity: { ...buildIdentityOf(fixtureIdentity()), sourceSha },
    sourceSha,
    sourceTree: "6".repeat(40),
    version: VERSION,
  };
  writeFileSync(join(root, "architecture-build.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
};

const makeUpdate = (
  architecture: MacArchitecture,
  architectureRoot: string,
  sourceSha = SOURCE_SHA,
  includeDelta = true,
): string => {
  const root = join(fixture, `update-${architecture}`);
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root);
  const fullName = `Nodex-${VERSION}-${architecture}.tar.xz`;
  const fullPath = join(architectureRoot, fullName);
  const fullUrl = `https://github.com/junyudev/nodex/releases/download/v${VERSION}/${fullName}`;
  const deltaName = `Nodex-${PREVIOUS_VERSION}-to-${VERSION}-${architecture}.delta`;
  const deltaPath = join(root, deltaName);
  if (includeDelta) writeFileSync(deltaPath, `${architecture}:delta`);
  const deltas = includeDelta
    ? [
        {
          bytes: readFileSync(deltaPath).byteLength,
          edSignature: SIGNATURE,
          fromBuildVersion: PREVIOUS_VERSION,
          fromVersion: PREVIOUS_VERSION,
          name: deltaName,
          sha256: sha256File(deltaPath),
          toBuildVersion: BUILD_VERSION,
          toVersion: VERSION,
          url: `https://github.com/junyudev/nodex/releases/download/v${VERSION}/${deltaName}`,
        },
      ]
    : [];
  const appcastName = `Nodex-${VERSION}-appcast-${architecture}.xml`;
  const appcastPath = join(root, appcastName);
  const deltaXml = deltas
    .map(
      (delta) => `
      <sparkle:deltas><enclosure url="${delta.url}" length="${delta.bytes}" sparkle:edSignature="${delta.edSignature}" sparkle:deltaFrom="${delta.fromBuildVersion}" /></sparkle:deltas>`,
    )
    .join("");
  writeFileSync(
    appcastPath,
    `<?xml version="1.0"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
  <sparkle:version>${BUILD_VERSION}</sparkle:version>
  <sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
  <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
  <enclosure url="${fullUrl}" length="${readFileSync(fullPath).byteLength}" sparkle:edSignature="${SIGNATURE}" />${deltaXml}
</item></channel></rss>
`,
  );
  const manifest: SparkleArchitectureUpdateManifest = {
    architecture,
    channel: "stable",
    appcast: {
      bytes: readFileSync(appcastPath).byteLength,
      feedPath: `updates/stable/${architecture}/appcast.xml`,
      name: appcastName,
      sha256: sha256File(appcastPath),
    },
    deltas,
    full: {
      bytes: readFileSync(fullPath).byteLength,
      edSignature: SIGNATURE,
      name: fullName,
      sha256: sha256File(fullPath),
      url: fullUrl,
    },
    schemaVersion: 3,
    sourceSha,
    tag: `v${VERSION}`,
    target: {
      buildVersion: BUILD_VERSION,
      bundleId: "app.jyu.nodex",
      packageProvenanceSchema: PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION,
      teamIdentifier: NODEX_MACOS_TEAM_IDENTIFIER,
      version: VERSION,
    },
  };
  writeFileSync(
    join(root, `Nodex-${VERSION}-update-${architecture}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return root;
};

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "nodex-release-bundle-"));
  windows = {
    ...makeWindowsReleaseFixture(fixture),
    ...makeMobileReleaseFixture(fixture, fixtureIdentity()),
  };
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

test("assembles the complete macOS and Windows signed release closure", () => {
  const arm64 = makeArchitecture("arm64");
  const output = join(fixture, "output");
  const bundle = assembleReleaseBundle({
    ...windows,
    arm64Directory: arm64,
    arm64UpdateDirectory: makeUpdate("arm64", arm64),
    outputDirectory: output,
    identity: fixtureIdentity(),
  });

  expect(bundle.schemaVersion).toBe(9);
  expect(bundle.assets.map(({ name }) => name).sort()).toEqual(
    [
      `Nodex-${VERSION}-appcast-arm64.xml`,
      `Nodex-${VERSION}-arm64.tar.xz`,
      appComponentManifestName(VERSION, "darwin-arm64"),
      `Nodex-${VERSION}-update-arm64.json`,
      `Nodex-${PREVIOUS_VERSION}-to-${VERSION}-arm64.delta`,
      `Nodex-${VERSION}-arm64.dmg`,
      "Nodex-latest-arm64.dmg",
      `Nodex-${VERSION}-android.apk`,
      "Nodex-latest-android.apk",
      "release-identity.json",
      `Nodex-${VERSION}-windows-x64.exe`,
      "Nodex-latest-windows-x64.exe",
      appComponentManifestName(VERSION, "win32-x64"),
      `Nodex-${VERSION}-appcast-windows-x64.xml`,
      `Nodex-${VERSION}-update-windows-x64.json`,
    ].sort(),
  );
  for (const [target, source] of [
    ["darwin-arm64", arm64],
    ["win32-x64", windows.windowsX64Directory],
  ] as const) {
    const componentName = appComponentManifestName(VERSION, target);
    const componentDigest = sha256File(join(source, componentName));
    expect(sha256File(join(output, componentName))).toBe(componentDigest);
    expect(readFileSync(join(output, "SHA256SUMS"), "utf8")).toContain(
      `${componentDigest}  ${componentName}\n`,
    );
    expect(() =>
      parseReleaseBundleManifest({
        ...bundle,
        assets: bundle.assets.filter(({ name }) => name !== componentName),
      }),
    ).toThrow("missing a required");
  }
  // The certified iOS build travels with the bundle for TestFlight, never as a public asset.
  expect(readFileSync(join(output, "testflight", `Nodex-${VERSION}-ios.ipa`), "utf8")).toBe(
    `ios:${VERSION}`,
  );
  expect(bundle.assets.some(({ name }) => name.endsWith(".ipa"))).toBe(false);
  expect(bundle.assets.some(({ name }) => name.endsWith(".blockmap"))).toBe(false);
  expect(bundle.assets.some(({ name }) => name === "latest-mac.yml")).toBe(false);
  expect(
    releaseAssetPaths(join(output, "release-bundle.json"), windows.windowsPublicKey),
  ).toHaveLength(bundle.assets.length + 2);
  appendFileSync(join(output, "Nodex-latest-arm64.dmg"), "tampered");
  expect(() =>
    releaseAssetPaths(join(output, "release-bundle.json"), windows.windowsPublicKey),
  ).toThrow("does not match");
});

test("derives remote release identities without local copies of the full assets", () => {
  const arm64 = makeArchitecture("arm64");
  const output = join(fixture, "output");
  const bundle = assembleReleaseBundle({
    ...windows,
    arm64Directory: arm64,
    arm64UpdateDirectory: makeUpdate("arm64", arm64),
    outputDirectory: output,
    identity: fixtureIdentity(),
  });
  for (const asset of bundle.assets) rmSync(join(output, asset.name));

  const { assets: identities } = readPublishedReleaseIndex(join(output, "release-bundle.json"));
  expect([...identities.keys()].sort()).toEqual(
    [...bundle.assets.map(({ name }) => name), "release-bundle.json", "SHA256SUMS"].sort(),
  );
  for (const asset of bundle.assets) {
    expect(identities.get(asset.name)).toEqual({ bytes: asset.bytes, sha256: asset.sha256 });
  }

  appendFileSync(join(output, "SHA256SUMS"), "tampered\n");
  expect(() => readPublishedReleaseIndex(join(output, "release-bundle.json"))).toThrow(
    "SHA256SUMS does not match",
  );
});

test("reads a published ZIP index and rejects ZIP for new releases", () => {
  const arm64 = makeArchitecture("arm64");
  const output = join(fixture, "output");
  const bundle = assembleReleaseBundle({
    ...windows,
    arm64Directory: arm64,
    arm64UpdateDirectory: makeUpdate("arm64", arm64),
    outputDirectory: output,
    identity: fixtureIdentity(),
  });
  const zipAsset = {
    ...bundle.assets.find(({ role }) => role === "sparkle-full")!,
    name: `Nodex-${VERSION}-arm64.zip`,
  };
  const legacyWindows = "windows-arm64";
  const legacyAssets = bundle.assets
    .filter(({ name }) => name !== appComponentManifestName(VERSION, "win32-x64"))
    .flatMap((asset) =>
      asset.architecture === "windows-x64"
        ? [
            asset,
            {
              ...asset,
              architecture: legacyWindows,
              name: asset.name.replace("windows-x64", legacyWindows),
            },
          ]
        : [asset],
    );
  const legacyArchitectures = {
    ...bundle.architectures,
    [legacyWindows]: bundle.architectures["windows-x64"],
  };
  const historyFor = (schemaVersion: number) => ({
    ...bundle,
    schemaVersion,
    architectures: schemaVersion === 8 ? bundle.architectures : legacyArchitectures,
    mobile: schemaVersion === 4 ? undefined : bundle.mobile,
    assets: legacyAssets
      .filter(({ architecture }) => schemaVersion !== 8 || architecture !== legacyWindows)
      .filter(
        ({ role, name }) =>
          (schemaVersion >= 7 || role !== "components-manifest") &&
          (schemaVersion >= 6 || name !== `Nodex-${VERSION}-arm64.dmg`) &&
          (schemaVersion >= 5 || role !== "android-apk"),
      )
      .map((asset) => (schemaVersion < 7 && asset.role === "sparkle-full" ? zipAsset : asset)),
  });
  for (const schemaVersion of [4, 5, 6, 7, 8]) {
    const legacy = historyFor(schemaVersion);
    const parsed = parseReleaseHistoryBundle(legacy);
    expect(parsed.schemaVersion).toBe(schemaVersion);
    if (schemaVersion === 4) expect(parsed.mobile).toBeUndefined();
    expect(() => parseReleaseBundleManifest(legacy)).toThrow("manifest is invalid");
  }
  expect(() =>
    parseReleaseBundleManifest({ ...historyFor(7), schemaVersion: bundle.schemaVersion }),
  ).toThrow("manifest is invalid");
  const history = historyFor(6);
  const bundlePath = join(output, "release-bundle.json");
  writeFileSync(bundlePath, JSON.stringify(history));
  const checksums = [
    ...history.assets,
    { name: "release-bundle.json", sha256: sha256File(bundlePath) },
  ].sort((left, right) => left.name.localeCompare(right.name));
  writeFileSync(
    join(output, "SHA256SUMS"),
    checksums.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(""),
  );

  expect(parseReleaseHistoryBundle(history).assets).toContainEqual(zipAsset);
  expect(readPublishedReleaseIndex(bundlePath).assets.get(zipAsset.name)).toEqual({
    bytes: zipAsset.bytes,
    sha256: zipAsset.sha256,
  });
  expect(() => releaseAssetPaths(bundlePath)).toThrow("manifest is invalid");
  for (const parse of [parseReleaseBundleManifest, parseReleaseHistoryBundle]) {
    expect(() => parse({ ...bundle, assets: [...bundle.assets, zipAsset] })).toThrow(
      "unsupported asset",
    );
  }
});

test("rejects a Sparkle full update that does not match the architecture archive", () => {
  const arm64 = makeArchitecture("arm64");
  const armUpdate = makeUpdate("arm64", arm64);
  appendFileSync(join(arm64, `Nodex-${VERSION}-arm64.tar.xz`), "tampered");

  expect(() =>
    assembleReleaseBundle({
      ...windows,
      arm64Directory: arm64,
      arm64UpdateDirectory: armUpdate,
      outputDirectory: join(fixture, "output"),
      identity: fixtureIdentity(),
    }),
  ).toThrow("does not match its manifest");
});

test("rejects a missing or tampered Sparkle delta from the dynamic asset closure", () => {
  const arm64 = makeArchitecture("arm64");
  const armUpdate = makeUpdate("arm64", arm64);
  const deltaPath = join(armUpdate, `Nodex-${PREVIOUS_VERSION}-to-${VERSION}-arm64.delta`);
  rmSync(deltaPath);
  expect(() =>
    assembleReleaseBundle({
      ...windows,
      arm64Directory: arm64,
      arm64UpdateDirectory: armUpdate,
      outputDirectory: join(fixture, "missing-output"),
      identity: fixtureIdentity(),
    }),
  ).toThrow();

  const replacementUpdate = makeUpdate("arm64", arm64);
  appendFileSync(
    join(replacementUpdate, `Nodex-${PREVIOUS_VERSION}-to-${VERSION}-arm64.delta`),
    "tampered",
  );
  expect(() =>
    assembleReleaseBundle({
      ...windows,
      arm64Directory: arm64,
      arm64UpdateDirectory: replacementUpdate,
      outputDirectory: join(fixture, "tampered-output"),
      identity: fixtureIdentity(),
    }),
  ).toThrow("does not match");
});

test("rejects appcast enclosure metadata that diverges from the update manifest", () => {
  const arm64 = makeArchitecture("arm64");
  const armUpdate = makeUpdate("arm64", arm64);
  const appcastPath = join(armUpdate, `Nodex-${VERSION}-appcast-arm64.xml`);
  const appcast = readFileSync(appcastPath, "utf8");
  const expectedLength = readFileSync(join(arm64, `Nodex-${VERSION}-arm64.tar.xz`)).byteLength;
  writeFileSync(
    appcastPath,
    appcast.replace(`length="${expectedLength}"`, `length="${expectedLength + 1}"`),
  );
  const manifestPath = join(armUpdate, `Nodex-${VERSION}-update-arm64.json`);
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as SparkleArchitectureUpdateManifest;
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        appcast: {
          ...manifest.appcast,
          bytes: readFileSync(appcastPath).byteLength,
          sha256: sha256File(appcastPath),
        },
      },
      null,
      2,
    )}\n`,
  );

  expect(() =>
    assembleReleaseBundle({
      ...windows,
      arm64Directory: arm64,
      arm64UpdateDirectory: armUpdate,
      outputDirectory: join(fixture, "mismatched-appcast-output"),
      identity: fixtureIdentity(),
    }),
  ).toThrow("full enclosure");
});

test("rejects a Sparkle appcast below the product macOS baseline", () => {
  const arm64 = makeArchitecture("arm64");
  const armUpdate = makeUpdate("arm64", arm64);
  const appcastPath = join(armUpdate, `Nodex-${VERSION}-appcast-arm64.xml`);
  writeFileSync(
    appcastPath,
    readFileSync(appcastPath, "utf8").replace(
      "<sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>",
      "<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>",
    ),
  );
  const manifestPath = join(armUpdate, `Nodex-${VERSION}-update-arm64.json`);
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as SparkleArchitectureUpdateManifest;
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        appcast: {
          ...manifest.appcast,
          bytes: readFileSync(appcastPath).byteLength,
          sha256: sha256File(appcastPath),
        },
      },
      null,
      2,
    )}\n`,
  );

  expect(() =>
    assembleReleaseBundle({
      ...windows,
      arm64Directory: arm64,
      arm64UpdateDirectory: armUpdate,
      outputDirectory: join(fixture, "old-macos-appcast-output"),
      identity: fixtureIdentity(),
    }),
  ).toThrow("require macOS 15.0");
});

test("rejects architecture and update manifests from different source commits", () => {
  const arm64 = makeArchitecture("arm64");

  expect(() =>
    assembleReleaseBundle({
      ...windows,
      arm64Directory: arm64,
      arm64UpdateDirectory: makeUpdate("arm64", arm64, "f".repeat(40)),
      outputDirectory: join(fixture, "output"),
      identity: fixtureIdentity(),
    }),
  ).toThrow("one release identity");
});

test("rejects top-level source identity fields that diverge from the embedded identity", () => {
  const arm64 = makeArchitecture("arm64");
  const architecturePath = join(arm64, "architecture-build.json");
  const architecture = JSON.parse(
    readFileSync(architecturePath, "utf8"),
  ) as ArchitectureBuildManifest;
  expect(() =>
    parseArchitectureBuildManifest({
      ...architecture,
      sourceTree: "7".repeat(40),
    }),
  ).toThrow("source identity");

  const output = join(fixture, "output");
  assembleReleaseBundle({
    ...windows,
    arm64Directory: arm64,
    arm64UpdateDirectory: makeUpdate("arm64", arm64),
    outputDirectory: output,
    identity: fixtureIdentity(),
  });
  const bundlePath = join(output, "release-bundle.json");
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as ReturnType<
    typeof assembleReleaseBundle
  >;
  expect(() =>
    parseReleaseBundleManifest({
      ...bundle,
      sourceSha: "8".repeat(40),
    }),
  ).toThrow("source identity");
});

test("rejects unlisted architecture artifacts", () => {
  const arm64 = makeArchitecture("arm64");
  const manifestPath = join(arm64, "architecture-build.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArchitectureBuildManifest;
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        artifacts: [...manifest.artifacts, manifest.artifacts[0]],
      },
      null,
      2,
    )}\n`,
  );

  expect(() =>
    assembleReleaseBundle({
      ...windows,
      arm64Directory: arm64,
      arm64UpdateDirectory: makeUpdate("arm64", arm64),
      outputDirectory: join(fixture, "output"),
      identity: fixtureIdentity(),
    }),
  ).toThrow("architecture artifacts do not match");
});

test("ships the exact certified APK under its versioned name and the stable alias", () => {
  const arm64 = makeArchitecture("arm64");
  const output = join(fixture, "output");
  const bundle = assembleReleaseBundle({
    ...windows,
    arm64Directory: arm64,
    arm64UpdateDirectory: makeUpdate("arm64", arm64),
    outputDirectory: output,
    identity: fixtureIdentity(),
  });
  const apks = bundle.assets.filter(({ role }) => role === "android-apk");
  expect(new Set(apks.map(({ sha256 }) => sha256))).toEqual(
    new Set([bundle.mobile.android.artifact.sha256]),
  );
  expect(bundle.mobile.android.app).toEqual({
    id: "app.jyu.nodex.mobile",
    version: VERSION,
    build: "1",
  });
  expect(bundle.mobile.ios.app.build).toBe(BUILD_VERSION);

  const manifest = JSON.parse(readFileSync(join(output, "release-bundle.json"), "utf8"));
  const aliased = {
    ...manifest,
    assets: manifest.assets.map((asset: { name: string; sha256: string }) =>
      asset.name === "Nodex-latest-android.apk" ? { ...asset, sha256: "f".repeat(64) } : asset,
    ),
  };
  expect(() => parseReleaseBundleManifest(aliased)).toThrow("exact APK");
  const { mobile: _mobile, ...withoutMobile } = manifest;
  expect(() => parseReleaseBundleManifest(withoutMobile)).toThrow("invalid");
});

test("refuses a phone build signed by anyone but Nodex", () => {
  const arm64 = makeArchitecture("arm64");
  const androidDirectory = makeMobileBuild(join(fixture, "debug"), "android", fixtureIdentity(), {
    signer: "e".repeat(64),
  });
  expect(() =>
    assembleReleaseBundle({
      ...windows,
      androidDirectory,
      arm64Directory: arm64,
      arm64UpdateDirectory: makeUpdate("arm64", arm64),
      outputDirectory: join(fixture, "output"),
      identity: fixtureIdentity(),
    }),
  ).toThrow("signer");
});
