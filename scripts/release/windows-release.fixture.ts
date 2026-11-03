import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION } from "../package-provenance.mjs";
import type { ArchitectureBuildManifest } from "./bundle";
import { sha256File, type ReleaseIdentity } from "./model";
import { createWindowsArchitectureUpdate } from "./windows-updates";
import { WINDOWS_ARCHITECTURES, windowsInstallerName } from "./targets";

export const fixtureIdentity = (channel: "stable" | "nightly" = "stable"): ReleaseIdentity => ({
  schemaVersion: 1,
  channel,
  sourceSha: "1".repeat(40),
  sourceTree: "6".repeat(40),
  sourceVersion: "0.2.2",
  version: channel === "stable" ? "0.2.2" : "0.2.3-nightly.19700101.1",
  buildVersion: "1.0.1",
  tag: channel === "stable" ? "v0.2.2" : "v0.2.3-nightly.19700101.1",
  mainlineOrdinal: 1,
  sourceDate: "1970-01-01",
});

export function makeWindowsReleaseFixture(root: string, identity = fixtureIdentity()) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  const signFile = (filePath: string) =>
    sign(null, readFileSync(filePath), privateKey).toString("base64");
  const builds = WINDOWS_ARCHITECTURES.map((arch) => {
    const architecture = `windows-${arch}` as const;
    const build = join(root, architecture);
    const update = join(root, `update-${architecture}`);
    mkdirSync(build, { recursive: true });
    const name = windowsInstallerName(identity.version, arch);
    const installerPath = join(build, name);
    writeFileSync(installerPath, `installer:${arch}:${identity.version}`);
    const provenancePath = join(build, "windows-build-provenance.json");
    writeFileSync(provenancePath, "provenance");
    const manifest: ArchitectureBuildManifest = {
      schemaVersion: 2,
      architecture,
      buildChannel: identity.channel,
      releaseIdentity: identity,
      sourceSha: identity.sourceSha,
      sourceTree: identity.sourceTree,
      version: identity.version,
      tag: identity.tag,
      artifacts: [
        {
          name,
          architecture,
          role: "windows-installer",
          bytes: statSync(installerPath).size,
          sha256: sha256File(installerPath),
        },
      ],
      packageProvenanceSha256: sha256File(provenancePath),
      agentSkills: { manifestSha256: "9".repeat(64), treeSha256: "a".repeat(64) },
      preparedBuild: { generation: "7".repeat(64), manifestSha256: "3".repeat(64), state: "clean" },
      runtimeLocks: {
        agentSha256: "4".repeat(64),
        browserSha256: "5".repeat(64),
        sparkleSha256: "b".repeat(64),
        nodeSha256: "c".repeat(64),
      },
      runner: { image: "test" },
    };
    const probePath = join(build, "installed-app-probe.json");
    writeFileSync(
      probePath,
      JSON.stringify({
        failures: [],
        evidence: { target: architecture },
        normalQuit: {},
        upgrade: {},
        uninstall: {},
      }),
    );
    writeFileSync(
      provenancePath,
      JSON.stringify({
        schemaVersion: 1,
        architecture,
        buildChannel: identity.channel,
        releaseIdentity: identity,
        artifacts: manifest.artifacts,
        runtimeLocks: manifest.runtimeLocks,
        preparedManifestSha256: manifest.preparedBuild.manifestSha256,
        installedProbeSha256: sha256File(probePath),
      }),
    );
    writeFileSync(
      join(build, "architecture-build.json"),
      JSON.stringify({ ...manifest, packageProvenanceSha256: sha256File(provenancePath) }),
    );
    createWindowsArchitectureUpdate({
      architecture: arch,
      identity,
      installerPath,
      outputDirectory: update,
      publishedAt: "1970-01-01T00:00:00Z",
      releaseNotes: "Release <notes> & details",
      publicKey: rawPublicKey,
      sign: signFile,
      sealAppcast: () => {},
    });
    return { build, update };
  });
  return {
    windowsX64Directory: builds[0].build,
    windowsArm64Directory: builds[1].build,
    windowsX64UpdateDirectory: builds[0].update,
    windowsArm64UpdateDirectory: builds[1].update,
    windowsPublicKey: rawPublicKey,
  };
}

export function makeReleaseFixture(root: string, channel: "stable" | "nightly" = "stable") {
  const identity = fixtureIdentity(channel);
  const windows = makeWindowsReleaseFixture(root, identity);
  const arm64Directory = join(root, "macos-arm64");
  const arm64UpdateDirectory = join(root, "update-macos-arm64");
  mkdirSync(arm64Directory);
  mkdirSync(arm64UpdateDirectory);
  const signature = `${"A".repeat(86)}==`;
  const fileIdentity = (directory: string, name: string) => ({
    name,
    bytes: statSync(join(directory, name)).size,
    sha256: sha256File(join(directory, name)),
  });
  const artifacts = (
    [
      [`Nodex-${identity.version}-arm64.dmg`, "dmg"],
      [`Nodex-${identity.version}-arm64.zip`, "sparkle-full"],
    ] as const
  ).map(([name, role]) => {
    writeFileSync(join(arm64Directory, name), `macos:${name}`);
    return { ...fileIdentity(arm64Directory, name), architecture: "arm64", role };
  });
  writeFileSync(
    join(arm64Directory, "architecture-build.json"),
    JSON.stringify({
      ...JSON.parse(
        readFileSync(join(windows.windowsX64Directory, "architecture-build.json"), "utf8"),
      ),
      architecture: "arm64",
      artifacts,
    }),
  );
  const full = {
    ...fileIdentity(arm64Directory, `Nodex-${identity.version}-arm64.zip`),
    edSignature: signature,
    url: `https://github.com/junyudev/nodex/releases/download/${identity.tag}/Nodex-${identity.version}-arm64.zip`,
  };
  const appcastName = `Nodex-${identity.version}-appcast-arm64.xml`;
  writeFileSync(
    join(arm64UpdateDirectory, appcastName),
    `<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>${identity.buildVersion}</sparkle:version><sparkle:shortVersionString>${identity.version}</sparkle:shortVersionString><sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion><enclosure url="${full.url}" length="${full.bytes}" sparkle:edSignature="${signature}"/></item></channel></rss>`,
  );
  writeFileSync(
    join(arm64UpdateDirectory, `Nodex-${identity.version}-update-arm64.json`),
    JSON.stringify({
      architecture: "arm64",
      channel: identity.channel,
      schemaVersion: 2,
      sourceSha: identity.sourceSha,
      tag: identity.tag,
      full,
      deltas: [],
      appcast: {
        ...fileIdentity(arm64UpdateDirectory, appcastName),
        feedPath: `updates/${identity.channel}/arm64/appcast.xml`,
      },
      target: {
        version: identity.version,
        buildVersion: identity.buildVersion,
        bundleId: "app.jyu.nodex",
        packageProvenanceSchema: PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION,
        teamIdentifier: "8HGUT3HC4Z",
      },
    }),
  );
  const identityPath = join(root, "identity.json");
  writeFileSync(identityPath, JSON.stringify(identity));
  return { ...windows, arm64Directory, arm64UpdateDirectory, identityPath };
}
