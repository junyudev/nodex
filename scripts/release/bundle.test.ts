import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import {
  assembleReleaseBundle,
  parseArchitectureBuildManifest,
  parseReleaseBundleManifest,
  type ArchitectureBuildManifest,
  type MacArchitecture,
} from "./bundle";
import { releaseAssetPaths, remoteReleaseAssetIdentities } from "./github-release";
import { sha256File } from "./model";
import { projectReleaseAppcasts } from "./pages";
import {
  NODEX_MACOS_TEAM_IDENTIFIER,
  type SparkleArchitectureUpdateManifest,
} from "./sparkle-manifest";

let fixture = "";
const VERSION = "0.2.2";
const PREVIOUS_VERSION = "0.2.1";
const BUILD_VERSION = "1.0.1";
const SOURCE_SHA = "1".repeat(40);
const SIGNATURE = `${"A".repeat(86)}==`;

const appcastFor = (version: string): string => `<?xml version="1.0"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel><item><sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString></item></channel>
</rss>
`;

const makeArchitecture = (architecture: MacArchitecture, sourceSha = SOURCE_SHA): string => {
  const root = join(fixture, `architecture-${architecture}`);
  mkdirSync(root);
  const artifactSpecs = [
    [`Nodex-${VERSION}-${architecture}.dmg`, "dmg"],
    [`Nodex-${VERSION}-${architecture}.zip`, "sparkle-full"],
  ] as const;
  const artifacts = artifactSpecs.map(([name, role]) => {
    const filePath = join(root, name);
    writeFileSync(filePath, `${architecture}:${name}`);
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
      generation: (architecture === "arm64" ? "7" : "8").repeat(64),
      manifestSha256: "3".repeat(64),
      state: "clean",
    },
    runner: { image: "test" },
    runtimeLocks: {
      agentSha256: "4".repeat(64),
      browserSha256: "5".repeat(64),
      sparkleSha256: "b".repeat(64),
    },
    schemaVersion: 2,
    releaseIdentity: {
      schemaVersion: 1,
      channel: "stable",
      sourceSha,
      sourceTree: "6".repeat(40),
      sourceVersion: VERSION,
      version: VERSION,
      buildVersion: BUILD_VERSION,
      tag: `v${VERSION}`,
      mainlineOrdinal: 1,
      sourceDate: "1970-01-01",
    },
    sourceSha,
    sourceTree: "6".repeat(40),
    tag: `v${VERSION}`,
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
  const fullName = `Nodex-${VERSION}-${architecture}.zip`;
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
    schemaVersion: 2,
    sourceSha,
    tag: `v${VERSION}`,
    target: {
      buildVersion: BUILD_VERSION,
      bundleId: "app.jyu.nodex",
      packageProvenanceSchema: 5,
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
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

test("assembles the exact dual-architecture Sparkle asset closure", () => {
  const arm64 = makeArchitecture("arm64");
  const x64 = makeArchitecture("x64");
  const output = join(fixture, "output");
  const bundle = assembleReleaseBundle({
    arm64Directory: arm64,
    arm64UpdateDirectory: makeUpdate("arm64", arm64),
    outputDirectory: output,
    sourceSha: SOURCE_SHA,
    version: VERSION,
    x64Directory: x64,
    x64UpdateDirectory: makeUpdate("x64", x64),
  });

  expect(bundle.schemaVersion).toBe(2);
  expect(bundle.assets.map(({ name }) => name).sort()).toEqual(
    [
      `Nodex-${VERSION}-appcast-arm64.xml`,
      `Nodex-${VERSION}-appcast-x64.xml`,
      `Nodex-${VERSION}-arm64.zip`,
      `Nodex-${VERSION}-update-arm64.json`,
      `Nodex-${VERSION}-update-x64.json`,
      `Nodex-${VERSION}-x64.zip`,
      `Nodex-${PREVIOUS_VERSION}-to-${VERSION}-arm64.delta`,
      `Nodex-${PREVIOUS_VERSION}-to-${VERSION}-x64.delta`,
      "Nodex-latest-arm64.dmg",
      "Nodex-latest-x64.dmg",
      "release-identity.json",
    ].sort(),
  );
  expect(bundle.assets.some(({ name }) => name.endsWith(".blockmap"))).toBe(false);
  expect(bundle.assets.some(({ name }) => name === "latest-mac.yml")).toBe(false);
  expect(releaseAssetPaths(join(output, "release-bundle.json"))).toHaveLength(
    bundle.assets.length + 2,
  );
  const site = join(fixture, "site");
  const currentSite = join(fixture, "current-site");
  for (const architecture of ["arm64", "x64"] as const) {
    const feed = join(currentSite, `updates/stable/${architecture}/appcast.xml`);
    mkdirSync(dirname(feed), { recursive: true });
    writeFileSync(feed, appcastFor("0.2.0"));
  }
  projectReleaseAppcasts({
    bundlePath: join(output, "release-bundle.json"),
    existingSiteDirectory: currentSite,
    siteDirectory: site,
  });
  expect(readFileSync(join(site, "updates/stable/arm64/appcast.xml"), "utf8")).toBe(
    readFileSync(join(output, `Nodex-${VERSION}-appcast-arm64.xml`), "utf8"),
  );
  expect(readFileSync(join(site, "updates/stable/x64/appcast.xml"), "utf8")).toBe(
    readFileSync(join(output, `Nodex-${VERSION}-appcast-x64.xml`), "utf8"),
  );
  writeFileSync(join(currentSite, "updates/stable/arm64/appcast.xml"), appcastFor("2.0.0"));
  expect(() =>
    projectReleaseAppcasts({
      bundlePath: join(output, "release-bundle.json"),
      existingSiteDirectory: currentSite,
      siteDirectory: join(fixture, "rollback-site"),
    }),
  ).toThrow("cannot move");
  appendFileSync(join(output, "Nodex-latest-arm64.dmg"), "tampered");
  expect(() => releaseAssetPaths(join(output, "release-bundle.json"))).toThrow("does not match");
});

test("derives remote release identities without local copies of the full assets", () => {
  const arm64 = makeArchitecture("arm64");
  const x64 = makeArchitecture("x64");
  const output = join(fixture, "output");
  const bundle = assembleReleaseBundle({
    arm64Directory: arm64,
    arm64UpdateDirectory: makeUpdate("arm64", arm64),
    outputDirectory: output,
    sourceSha: SOURCE_SHA,
    version: VERSION,
    x64Directory: x64,
    x64UpdateDirectory: makeUpdate("x64", x64),
  });
  for (const asset of bundle.assets) rmSync(join(output, asset.name));

  const identities = remoteReleaseAssetIdentities(join(output, "release-bundle.json"));
  expect([...identities.keys()].sort()).toEqual(
    [...bundle.assets.map(({ name }) => name), "release-bundle.json", "SHA256SUMS"].sort(),
  );
  for (const asset of bundle.assets) {
    expect(identities.get(asset.name)).toEqual({ bytes: asset.bytes, sha256: asset.sha256 });
  }

  appendFileSync(join(output, "SHA256SUMS"), "tampered\n");
  expect(() => remoteReleaseAssetIdentities(join(output, "release-bundle.json"))).toThrow(
    "SHA256SUMS does not match",
  );
});

test("rejects a Sparkle full update that does not match the architecture ZIP", () => {
  const arm64 = makeArchitecture("arm64");
  const x64 = makeArchitecture("x64");
  const armUpdate = makeUpdate("arm64", arm64);
  appendFileSync(join(arm64, `Nodex-${VERSION}-arm64.zip`), "tampered");

  expect(() =>
    assembleReleaseBundle({
      arm64Directory: arm64,
      arm64UpdateDirectory: armUpdate,
      outputDirectory: join(fixture, "output"),
      sourceSha: SOURCE_SHA,
      version: VERSION,
      x64Directory: x64,
      x64UpdateDirectory: makeUpdate("x64", x64),
    }),
  ).toThrow("does not match its manifest");
});

test("rejects a missing or tampered Sparkle delta from the dynamic asset closure", () => {
  const arm64 = makeArchitecture("arm64");
  const x64 = makeArchitecture("x64");
  const armUpdate = makeUpdate("arm64", arm64);
  const deltaPath = join(armUpdate, `Nodex-${PREVIOUS_VERSION}-to-${VERSION}-arm64.delta`);
  rmSync(deltaPath);
  expect(() =>
    assembleReleaseBundle({
      arm64Directory: arm64,
      arm64UpdateDirectory: armUpdate,
      outputDirectory: join(fixture, "missing-output"),
      sourceSha: SOURCE_SHA,
      version: VERSION,
      x64Directory: x64,
      x64UpdateDirectory: makeUpdate("x64", x64),
    }),
  ).toThrow();

  const replacementUpdate = makeUpdate("arm64", arm64);
  appendFileSync(
    join(replacementUpdate, `Nodex-${PREVIOUS_VERSION}-to-${VERSION}-arm64.delta`),
    "tampered",
  );
  expect(() =>
    assembleReleaseBundle({
      arm64Directory: arm64,
      arm64UpdateDirectory: replacementUpdate,
      outputDirectory: join(fixture, "tampered-output"),
      sourceSha: SOURCE_SHA,
      version: VERSION,
      x64Directory: x64,
      x64UpdateDirectory: makeUpdate("x64", x64),
    }),
  ).toThrow("does not match");
});

test("rejects appcast enclosure metadata that diverges from the update manifest", () => {
  const arm64 = makeArchitecture("arm64");
  const x64 = makeArchitecture("x64");
  const armUpdate = makeUpdate("arm64", arm64);
  const appcastPath = join(armUpdate, `Nodex-${VERSION}-appcast-arm64.xml`);
  const appcast = readFileSync(appcastPath, "utf8");
  const expectedLength = readFileSync(join(arm64, `Nodex-${VERSION}-arm64.zip`)).byteLength;
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
      arm64Directory: arm64,
      arm64UpdateDirectory: armUpdate,
      outputDirectory: join(fixture, "mismatched-appcast-output"),
      sourceSha: SOURCE_SHA,
      version: VERSION,
      x64Directory: x64,
      x64UpdateDirectory: makeUpdate("x64", x64),
    }),
  ).toThrow("full enclosure");
});

test("rejects a Sparkle appcast below the product macOS baseline", () => {
  const arm64 = makeArchitecture("arm64");
  const x64 = makeArchitecture("x64");
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
      arm64Directory: arm64,
      arm64UpdateDirectory: armUpdate,
      outputDirectory: join(fixture, "old-macos-appcast-output"),
      sourceSha: SOURCE_SHA,
      version: VERSION,
      x64Directory: x64,
      x64UpdateDirectory: makeUpdate("x64", x64),
    }),
  ).toThrow("require macOS 15.0");
});

test("rejects architecture and update manifests from different source commits", () => {
  const arm64 = makeArchitecture("arm64");
  const x64 = makeArchitecture("x64");

  expect(() =>
    assembleReleaseBundle({
      arm64Directory: arm64,
      arm64UpdateDirectory: makeUpdate("arm64", arm64, "f".repeat(40)),
      outputDirectory: join(fixture, "output"),
      sourceSha: SOURCE_SHA,
      version: VERSION,
      x64Directory: x64,
      x64UpdateDirectory: makeUpdate("x64", x64),
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

  const x64 = makeArchitecture("x64");
  const output = join(fixture, "output");
  assembleReleaseBundle({
    arm64Directory: arm64,
    arm64UpdateDirectory: makeUpdate("arm64", arm64),
    outputDirectory: output,
    sourceSha: SOURCE_SHA,
    version: VERSION,
    x64Directory: x64,
    x64UpdateDirectory: makeUpdate("x64", x64),
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
  const x64 = makeArchitecture("x64");
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
      arm64Directory: arm64,
      arm64UpdateDirectory: makeUpdate("arm64", arm64),
      outputDirectory: join(fixture, "output"),
      sourceSha: SOURCE_SHA,
      version: VERSION,
      x64Directory: x64,
      x64UpdateDirectory: makeUpdate("x64", x64),
    }),
  ).toThrow("architecture artifacts do not match");
});
