import { expect, test } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION } from "../package-provenance.mjs";
import { fetchSparkleHistory } from "./sparkle";
import { sha256File } from "./model";

const VERSION = "0.2.3-nightly.20260820.1185";
const TAG = `v${VERSION}`;
const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

const makeHistory = (root: string, schema: number, corruptDigest: boolean) => {
  const source = path.join(root, "source");
  mkdirSync(source);
  const fullName = `Nodex-${VERSION}-arm64.zip`;
  const appcastName = `Nodex-${VERSION}-appcast-arm64.xml`;
  const updateName = `Nodex-${VERSION}-update-arm64.json`;
  const fullUrl = `https://github.com/junyudev/nodex/releases/download/${TAG}/${fullName}`;
  const signature = `${"A".repeat(86)}==`;
  writeFileSync(path.join(source, fullName), "full-update");
  const identity = (name: string) => ({
    bytes: readFileSync(path.join(source, name)).byteLength,
    name,
    sha256: sha256File(path.join(source, name)),
  });
  const full = { ...identity(fullName), edSignature: signature, url: fullUrl };
  writeFileSync(
    path.join(source, appcastName),
    `<?xml version="1.0"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
<sparkle:version>1.11.85</sparkle:version><sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
<enclosure url="${fullUrl}" length="${full.bytes}" sparkle:edSignature="${signature}" />
</item></channel></rss>`,
  );
  writeFileSync(
    path.join(source, updateName),
    JSON.stringify({
      architecture: "arm64",
      channel: "nightly",
      schemaVersion: 2,
      sourceSha: SHA,
      tag: TAG,
      appcast: { ...identity(appcastName), feedPath: "updates/nightly/arm64/appcast.xml" },
      full,
      deltas: [],
      target: {
        buildVersion: "1.11.85",
        bundleId: "app.jyu.nodex",
        packageProvenanceSchema: schema,
        teamIdentifier: "8HGUT3HC4Z",
        version: VERSION,
      },
    }),
  );
  const assets = [
    ...(["arm64", "x64"] as const).flatMap((architecture) =>
      [
        [`Nodex-${VERSION}-${architecture}.dmg`, "dmg"],
        [`Nodex-${VERSION}-${architecture}.zip`, "sparkle-full"],
        [`Nodex-${VERSION}-appcast-${architecture}.xml`, "sparkle-appcast"],
        [`Nodex-${VERSION}-update-${architecture}.json`, "sparkle-update-manifest"],
      ].map(([name, role]) => ({
        architecture,
        role,
        ...(existsSync(path.join(source, name))
          ? identity(name)
          : { name, bytes: 1, sha256: DIGEST }),
      })),
    ),
    { name: "release-identity.json", role: "release-identity", bytes: 1, sha256: DIGEST },
  ];
  const architecture = {
    manifestSha256: DIGEST,
    preparedBuildGeneration: DIGEST,
    updateManifestSha256: DIGEST,
  };
  writeFileSync(
    path.join(source, "release-bundle.json"),
    JSON.stringify({
      schemaVersion: 2,
      sourceSha: SHA,
      sourceTree: SHA,
      version: VERSION,
      tag: TAG,
      assets,
      agentSkills: { manifestSha256: DIGEST, treeSha256: DIGEST },
      architectures: { arm64: architecture, x64: architecture },
      runtimeLocks: { agentSha256: DIGEST, browserSha256: DIGEST, sparkleSha256: DIGEST },
      releaseIdentity: {
        schemaVersion: 1,
        channel: "nightly",
        sourceSha: SHA,
        sourceTree: SHA,
        sourceVersion: "0.2.2",
        version: VERSION,
        buildVersion: "1.11.85",
        tag: TAG,
        mainlineOrdinal: 1185,
        sourceDate: "2026-08-20",
      },
    }),
  );
  writeFileSync(
    path.join(root, "release.json"),
    JSON.stringify({
      tag_name: TAG,
      draft: false,
      immutable: true,
      prerelease: true,
      published_at: "2026-08-20",
      assets: ["release-bundle.json", updateName, fullName, appcastName].map((name) => ({
        name,
        size: identity(name).bytes,
        digest: `sha256:${corruptDigest && name === updateName ? DIGEST : identity(name).sha256}`,
      })),
    }),
  );
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = path.dirname(__dirname);
const args = process.argv.slice(2);
if (args[0] === "api") {
  console.log(args[1].includes("/commits/") ? ${JSON.stringify(SHA)} : "[" + fs.readFileSync(path.join(root, "release.json"), "utf8") + "]");
} else if (args[0] === "release" && args[1] === "download") {
  const name = args[args.indexOf("--pattern") + 1];
  fs.appendFileSync(path.join(root, "downloads.jsonl"), JSON.stringify(name) + "\\n");
  fs.copyFileSync(path.join(root, "source", name), path.join(args[args.indexOf("--dir") + 1], name));
} else { throw new Error("Unexpected gh invocation"); }
`,
    { mode: 0o755 },
  );
  return { bin, updateName, fullName, appcastName };
};

test.each([
  { schema: 4, corruptDigest: false },
  { schema: PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION, corruptDigest: false },
  { schema: 4, corruptDigest: true },
])(
  "fetches only compatible, digest-verified history: $schema / $corruptDigest",
  ({ schema, corruptDigest }) => {
    const root = mkdtempSync(path.join(tmpdir(), "nodex-sparkle-history-"));
    const previousPath = process.env.PATH;
    try {
      const fixture = makeHistory(root, schema, corruptDigest);
      process.env.PATH = `${fixture.bin}${path.delimiter}${previousPath}`;
      const output = path.join(root, "history");
      const fetch = () =>
        fetchSparkleHistory({
          architecture: "arm64",
          channel: "nightly",
          currentVersion: "0.2.3-nightly.20260909.1425",
          currentBuildVersion: "1.14.25",
          outputDirectory: output,
          repository: "junyudev/nodex",
        });
      if (corruptDigest) {
        expect(fetch).toThrow("digest verification");
        return;
      }
      const compatible = schema === PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION;
      expect(fetch()).toEqual(compatible ? [path.join(output, VERSION)] : []);
      expect(existsSync(path.join(output, VERSION))).toBe(compatible);
      expect(
        readFileSync(path.join(root, "downloads.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        "release-bundle.json",
        fixture.updateName,
        ...(compatible ? [fixture.fullName, fixture.appcastName] : []),
      ]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
