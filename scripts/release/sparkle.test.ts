import { describe, expect, test, vi } from "vite-plus/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { load as parse } from "js-yaml";
import {
  fetchSparkleHistory,
  isEligibleSparkleHistoryRelease,
  normalizeGeneratedAppcast,
  oversizedDeltaRewrite,
  readSparkleHistoryManifest,
  stageSparkleDeltaSources,
  writeSparkleHistoryManifest,
} from "./sparkle";
import { verifySparkleAppcastContract } from "./sparkle-appcast-contract";
import { PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION } from "../package-provenance.mjs";
import {
  NODEX_MACOS_TEAM_IDENTIFIER,
  parseCompatibleSparkleHistoryUpdateManifest,
  parseSparkleArchitectureUpdateManifest,
} from "./sparkle-manifest";
import { sha256File } from "./model";

vi.mock("./signing", () => ({
  signFile: () => `${"A".repeat(86)}==`,
  runWithPrivateKey: () => "",
}));

test("round-trips empty and delimiter-containing history paths through a manifest", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sparkle-history-manifest-"));
  try {
    const manifest = path.join(root, "history.json");
    for (const directories of [
      [],
      [path.join(root, "first release"), path.join(root, "second:release\nwith newline")],
    ]) {
      writeSparkleHistoryManifest(manifest, directories);
      expect(readSparkleHistoryManifest(manifest)).toEqual(directories);
    }
    for (const invalid of [
      "task log\n[]",
      JSON.stringify(["relative/path"]),
      JSON.stringify([42]),
      "{}",
    ]) {
      writeFileSync(manifest, invalid);
      expect(() => readSparkleHistoryManifest(manifest)).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "Sparkle action carries history independently of task-runner stdout",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "sparkle-action-"));
    try {
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      mkdirSync(path.join(root, "architecture"));
      writeFileSync(
        path.join(root, "architecture", "architecture-build.json"),
        JSON.stringify({
          buildIdentity: { buildVersion: "1.0.1" },
        }),
      );
      const directories = [path.join(root, "first release"), path.join(root, "second:release")];
      writeFileSync(path.join(root, "expected.json"), JSON.stringify(directories));
      writeFileSync(
        path.join(bin, "vp"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
if (args.includes("release:fetch:sparkle-history")) {
  fs.copyFileSync(process.env.EXPECTED_HISTORY, flag("--manifest"));
  console.log("Task preparation log\\nTask timing summary");
} else if (args.includes("release:finalize:sparkle")) {
  fs.copyFileSync(flag("--history-manifest"), process.env.OBSERVED_HISTORY);
} else {
  throw new Error("Unexpected task: " + args.join(" "));
}
`,
        { mode: 0o755 },
      );
      const action = parse(
        readFileSync(
          path.resolve(import.meta.dirname, "../../.github/actions/finalize-sparkle/action.yml"),
          "utf8",
        ),
      ) as {
        runs: { steps: Array<{ name?: string; run?: string }> };
      };
      const env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RUNNER_TEMP: root,
        GITHUB_REPOSITORY: "fixture/repository",
        RELEASE_ARCH: "arm64",
        RELEASE_VERSION: "0.2.3",
        RELEASE_SOURCE_SHA: "HEAD",
        SPARKLE_ED25519_PRIVATE_KEY: "fixture-key",
        SPARKLE_OUTPUT: path.join(root, "output"),
        EXPECTED_HISTORY: path.join(root, "expected.json"),
        OBSERVED_HISTORY: path.join(root, "observed.json"),
      };
      for (const name of [
        "Fetch verified compatible update history",
        "Finalize signed appcast and deltas",
      ]) {
        const script = action.runs.steps.find((step) => step.name === name)?.run;
        if (!script) throw new Error(`Missing Sparkle step: ${name}`);
        execFileSync(
          "bash",
          [
            "-e",
            "-c",
            script
              .replaceAll("${{ inputs.channel }}", "nightly")
              .replaceAll("${{ inputs.rehearsal }}", ""),
          ],
          {
            env,
          },
        );
      }
      expect(readSparkleHistoryManifest(env.OBSERVED_HISTORY)).toEqual(directories);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("accepts only immutable published releases as delta history", () => {
  expect(
    isEligibleSparkleHistoryRelease({
      draft: false,
      immutable: true,
      prerelease: false,
    }),
  ).toBe(true);
  expect(
    isEligibleSparkleHistoryRelease({
      draft: false,
      immutable: false,
      prerelease: false,
    }),
  ).toBe(false);
  expect(
    isEligibleSparkleHistoryRelease({
      draft: false,
      prerelease: false,
    }),
  ).toBe(false);
});

test("normalizes a delta between Nightlies with the same app version", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sparkle-delta-source-"));
  try {
    const version = "0.5.2";
    const buildVersion = "1.23.97";
    const fromVersion = version;
    const fromBuildVersion = "1.23.7";
    const tag = `v${version}-nightly.20261107.2397`;
    const fullPath = path.join(root, `Nodex-${version}-arm64.tar.xz`);
    const deltaName = `Nodex${buildVersion}-${fromBuildVersion}.delta`;
    const appcastPath = path.join(root, "appcast.xml");
    writeFileSync(
      appcastPath,
      `
      <rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
        <sparkle:version>${buildVersion}</sparkle:version>
        <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
        <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
        <enclosure url="https://example.com/full.tar.xz"/>
        <sparkle:deltas>
          <enclosure url="https://example.com/${deltaName}" sparkle:deltaFrom="${fromBuildVersion}"/>
        </sparkle:deltas>
      </item></channel></rss>
    `,
    );
    writeFileSync(fullPath, "full update");
    writeFileSync(path.join(root, deltaName), "delta update");

    const options = {
      appcastPath,
      architecture: "arm64" as const,
      buildVersion,
      currentFullPath: fullPath,
      privateKey: "fixture-key",
      publishedAt: "2026-11-07T23:09:00Z",
      signUpdate: "fixture-signer",
      tag,
      version,
      workingDirectory: root,
    };
    expect(() => normalizeGeneratedAppcast({ ...options, history: new Map() })).toThrow(
      "Generated delta source build 1.23.7 is not in verified history.",
    );
    const history = new Map([
      [
        fromBuildVersion,
        { archivePath: path.join(root, `Nodex-${fromVersion}-arm64.tar.xz`), version: fromVersion },
      ],
    ]);
    const normalized = normalizeGeneratedAppcast({ ...options, history });
    const renamed = `Nodex-${fromBuildVersion}-to-${version}-arm64.delta`;
    expect(normalized.deltas).toEqual([
      expect.objectContaining({ fromBuildVersion, fromVersion, toVersion: version, name: renamed }),
    ]);
    expect(readFileSync(path.join(root, renamed), "utf8")).toBe("delta update");
    const xml = readFileSync(appcastPath, "utf8");
    verifySparkleAppcastContract(xml, {
      ...normalized,
      architecture: "arm64",
      target: { version, buildVersion },
    });
    writeFileSync(
      appcastPath,
      xml.replace("</channel>", "<item><title>Older release</title></item></channel>"),
    );
    expect(() => normalizeGeneratedAppcast({ ...options, history })).toThrow(
      "Generated appcast must contain only the current release item.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a delta is unaffordable only when a file over the limit is in both apps and changed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-sparkle-rewrite-"));
  try {
    const app = (name: string, files: Readonly<Record<string, string>>) => {
      const directory = path.join(root, name);
      for (const [file, contents] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        writeFileSync(path.join(directory, file), contents);
      }
      return directory;
    };
    const source = app("source", {
      "Contents/Resources/app.asar": "old bundle",
      "Contents/Resources/bin/codex": "a".repeat(64),
      "Contents/Frameworks/Electron": "e".repeat(40),
    });
    const sameRuntime = app("same-runtime", {
      "Contents/Resources/app.asar": "new bundle!",
      "Contents/Resources/bin/codex": "a".repeat(64),
      "Contents/Frameworks/Electron": "e".repeat(40),
      "Contents/Resources/bin/added": "n".repeat(64),
    });
    const newRuntime = app("new-runtime", {
      "Contents/Resources/app.asar": "new bundle!",
      "Contents/Resources/bin/codex": "b".repeat(64),
      "Contents/Frameworks/Electron": "f".repeat(40),
    });
    expect(oversizedDeltaRewrite(source, sameRuntime, 32)).toBeNull();
    expect(oversizedDeltaRewrite(source, newRuntime, 32)).toEqual({
      bytes: 64,
      path: path.join("Contents", "Resources", "bin", "codex"),
    });
    expect(oversizedDeltaRewrite(source, newRuntime, 64)).toBeNull();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

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
    name: `Nodex-${VERSION}-arm64.tar.xz`,
    sha256: "c".repeat(64),
    url: `https://github.com/junyudev/nodex/releases/download/v${VERSION}/Nodex-${VERSION}-arm64.tar.xz`,
  },
  schemaVersion: 3,
  sourceSha: "d".repeat(40),
  tag: `v${VERSION}`,
  target: {
    buildVersion: VERSION,
    bundleId: "app.jyu.nodex",
    packageProvenanceSchema: PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION,
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
  nightly.target.buildVersion = "1.8.42";
  nightly.tag = "v0.2.2-nightly.20260813.842";
  nightly.appcast.name = `Nodex-${nightly.target.version}-appcast-arm64.xml`;
  nightly.appcast.feedPath = "updates/nightly/arm64/appcast.xml";
  nightly.full.name = `Nodex-${nightly.target.version}-arm64.tar.xz`;
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

test("excludes older package formats only from history, never current release validation", () => {
  for (const schema of [4, 5]) {
    const candidate = {
      ...manifest(),
      target: { ...manifest().target, packageProvenanceSchema: schema },
    };
    expect(parseCompatibleSparkleHistoryUpdateManifest(candidate)).toBeNull();
    expect(() => parseSparkleArchitectureUpdateManifest(candidate)).toThrow("target identity");
  }
  expect(parseCompatibleSparkleHistoryUpdateManifest(manifest())).toEqual(
    parseSparkleArchitectureUpdateManifest(manifest()),
  );
});

test("fails closed on malformed, future, and invalid current history identities", () => {
  for (const schema of [undefined, "4", 0, -1, 4.5, PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION + 1]) {
    expect(() =>
      parseCompatibleSparkleHistoryUpdateManifest({
        ...manifest(),
        target: { ...manifest().target, packageProvenanceSchema: schema },
      }),
    ).toThrow();
  }
  const candidate = manifest();
  candidate.target.teamIdentifier = "OTHERTEAM1";
  expect(() => parseCompatibleSparkleHistoryUpdateManifest(candidate)).toThrow("target identity");
});

test("requires tar.xz for new updates while admitting the exact published ZIP in history", () => {
  const update = manifest();
  expect(parseSparkleArchitectureUpdateManifest(update).full.name).toMatch(/\.tar\.xz$/u);
  update.full.name = update.full.name.replace(/\.tar\.xz$/u, ".zip");
  update.full.url = update.full.url.replace(/\.tar\.xz$/u, ".zip");
  expect(() => parseSparkleArchitectureUpdateManifest(update)).toThrow("full update name");
  expect(parseCompatibleSparkleHistoryUpdateManifest(update)?.full).toEqual(update.full);
});

describe("Sparkle delta history staging", () => {
  const VERSION = "0.2.3-nightly.20260820.1185";
  const TAG = `v${VERSION}`;
  const SHA = "a".repeat(40);
  const DIGEST = "b".repeat(64);

  const makeHistory = (
    root: string,
    schema: number,
    corruptDigest: boolean,
    bundleSchema: 2 | 3,
    extension = "zip",
  ) => {
    const source = path.join(root, "source");
    mkdirSync(source);
    const fullName = `Nodex-${VERSION}-arm64.${extension}`;
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
      ...(bundleSchema === 2 ? (["arm64", "x64"] as const) : (["arm64"] as const)).flatMap(
        (architecture) =>
          [
            [`Nodex-${VERSION}-${architecture}.dmg`, "dmg"],
            [`Nodex-${VERSION}-${architecture}.${extension}`, "sparkle-full"],
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
        schemaVersion: bundleSchema,
        sourceSha: SHA,
        sourceTree: SHA,
        version: VERSION,
        tag: TAG,
        assets,
        agentSkills: { manifestSha256: DIGEST, treeSha256: DIGEST },
        architectures:
          bundleSchema === 2 ? { arm64: architecture, x64: architecture } : { arm64: architecture },
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

  test.skipIf(process.platform === "win32").each([
    { schema: 4, corruptDigest: false, bundleSchema: 3 as const, extension: "zip" },
    {
      schema: PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION,
      corruptDigest: false,
      bundleSchema: 3 as const,
      extension: "tar.xz",
    },
    {
      schema: PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION,
      corruptDigest: false,
      bundleSchema: 3 as const,
    },
    {
      schema: PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION,
      corruptDigest: false,
      bundleSchema: 2 as const,
    },
    { schema: 4, corruptDigest: true, bundleSchema: 3 as const },
  ])(
    "fetches only compatible, digest-verified history: $schema / $corruptDigest / bundle $bundleSchema / $extension",
    ({ schema, corruptDigest, bundleSchema, extension }) => {
      const root = mkdtempSync(path.join(tmpdir(), "nodex-sparkle-history-"));
      const previousPath = process.env.PATH;
      try {
        const fixture = makeHistory(root, schema, corruptDigest, bundleSchema, extension);
        process.env.PATH = `${fixture.bin}${path.delimiter}${previousPath}`;
        const output = path.join(root, "history");
        const fetch = () =>
          fetchSparkleHistory({
            architecture: "arm64",
            channel: "nightly",
            currentVersion: "0.2.3",
            currentBuildVersion: "1.14.25",
            outputDirectory: output,
            repository: "junyudev/nodex",
          });
        if (corruptDigest) {
          expect(fetch).toThrow("digest verification");
          return;
        }
        const compatible =
          bundleSchema === 3 && schema === PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION;
        const directories = fetch();
        expect(directories).toEqual(compatible ? [path.join(output, VERSION)] : []);
        if (compatible) {
          const stage = path.join(root, "stage");
          mkdirSync(stage);
          const archives = stageSparkleDeltaSources(directories, stage);
          expect(archives.get("1.11.85")).toEqual({
            archivePath: path.join(stage, `1.11.85-${fixture.fullName}`),
            version: VERSION,
          });
          expect(readdirSync(stage)).toEqual([`1.11.85-${fixture.fullName}`]);
          expect(() => stageSparkleDeltaSources(directories, stage)).toThrow(
            "Duplicate Sparkle history",
          );
        }
        expect(existsSync(path.join(output, VERSION))).toBe(compatible);
        expect(
          readFileSync(path.join(root, "downloads.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([
          "release-bundle.json",
          ...(bundleSchema === 3 ? [fixture.updateName] : []),
          ...(compatible ? [fixture.fullName, fixture.appcastName] : []),
        ]);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
