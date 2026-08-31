import { describe, expect, test } from "vite-plus/test";

import {
  NODEX_MACOS_TEAM_IDENTIFIER,
  parseSparkleArchitectureUpdateManifest,
} from "./sparkle-manifest";

const VERSION = "0.2.2";
const SIGNATURE = `${"A".repeat(86)}==`;

const manifest = () => ({
  architecture: "arm64",
  channel: "stable",
  appcast: {
    bytes: 123,
    feedPath: "updates/stable/arm64/appcast.xml",
    name: `Nodex-${VERSION}-appcast-arm64.xml`,
    sha256: "a".repeat(64),
  },
  deltas: [
    {
      bytes: 42,
      edSignature: SIGNATURE,
      fromBuildVersion: "0.2.1",
      fromVersion: "0.2.1",
      name: `Nodex-0.2.1-to-${VERSION}-arm64.delta`,
      sha256: "b".repeat(64),
      toBuildVersion: VERSION,
      toVersion: VERSION,
      url: `https://github.com/junyudev/nodex/releases/download/v${VERSION}/Nodex-0.2.1-to-${VERSION}-arm64.delta`,
    },
  ],
  full: {
    bytes: 456,
    edSignature: SIGNATURE,
    name: `Nodex-${VERSION}-arm64.zip`,
    sha256: "c".repeat(64),
    url: `https://github.com/junyudev/nodex/releases/download/v${VERSION}/Nodex-${VERSION}-arm64.zip`,
  },
  schemaVersion: 2,
  sourceSha: "d".repeat(40),
  tag: `v${VERSION}`,
  target: {
    buildVersion: VERSION,
    bundleId: "app.jyu.nodex",
    packageProvenanceSchema: 5,
    teamIdentifier: NODEX_MACOS_TEAM_IDENTIFIER,
    version: VERSION,
  },
});

describe("Sparkle architecture update manifest", () => {
  test("accepts a closed immutable release identity", () => {
    expect(parseSparkleArchitectureUpdateManifest(manifest())).toMatchObject({
      architecture: "arm64",
      tag: `v${VERSION}`,
      target: { version: VERSION },
    });
  });

  test("rejects mutable or cross-architecture enclosure URLs", () => {
    const candidate = manifest();
    candidate.full.url = `https://github.com/junyudev/nodex/releases/latest/download/${candidate.full.name}`;
    expect(() => parseSparkleArchitectureUpdateManifest(candidate)).toThrow("immutable");
  });

  test("rejects deltas that do not terminate at the target build", () => {
    const candidate = manifest();
    candidate.deltas[0]!.toBuildVersion = "0.2.3";
    expect(() => parseSparkleArchitectureUpdateManifest(candidate)).toThrow("target release");
  });

  test("rejects an update signed by a different Developer ID team", () => {
    const candidate = manifest();
    candidate.target.teamIdentifier = "OTHERTEAM1";
    expect(() => parseSparkleArchitectureUpdateManifest(candidate)).toThrow("target identity");
  });
});

test("accepts a nightly feed identity and rejects a stable feed path", () => {
  const nightly = manifest();
  nightly.channel = "nightly";
  nightly.target.version = "0.2.2-nightly.20260813.842";
  nightly.target.buildVersion = "1.8.42";
  nightly.tag = `v${nightly.target.version}`;
  nightly.appcast.name = `Nodex-${nightly.target.version}-appcast-arm64.xml`;
  nightly.appcast.feedPath = "updates/nightly/arm64/appcast.xml";
  nightly.full.name = `Nodex-${nightly.target.version}-arm64.zip`;
  nightly.full.url = `https://github.com/junyudev/nodex/releases/download/${nightly.tag}/${nightly.full.name}`;
  nightly.deltas[0]!.toBuildVersion = "1.8.42";
  nightly.deltas[0]!.toVersion = nightly.target.version;
  nightly.deltas[0]!.name = `Nodex-0.2.1-to-${nightly.target.version}-arm64.delta`;
  nightly.deltas[0]!.url = `https://github.com/junyudev/nodex/releases/download/${nightly.tag}/${nightly.deltas[0]!.name}`;
  nightly.deltas[0]!.toVersion = nightly.target.version;

  expect(parseSparkleArchitectureUpdateManifest(nightly)).toMatchObject({
    channel: "nightly",
    appcast: { feedPath: "updates/nightly/arm64/appcast.xml" },
    target: { buildVersion: "1.8.42", version: nightly.target.version },
  });

  const mismatched = {
    ...nightly,
    appcast: { ...nightly.appcast, feedPath: "updates/stable/arm64/appcast.xml" },
  };
  expect(() => parseSparkleArchitectureUpdateManifest(mismatched)).toThrow("projection identity");
});
