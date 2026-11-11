import { generateKeyPairSync, sign } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { assembleReleaseBundle, parseReleaseBundleManifest } from "./bundle";
import { releaseAssetPaths } from "./github-release";
import { projectReleaseAppcasts, verifyPublishedAppcasts } from "./pages";
import { sha256File } from "./model";
import { parseWindowsArchitectureUpdateManifest } from "./windows-updates";
import { fixtureIdentity, makeReleaseFixture } from "./windows-release.fixture";
import { RELEASE_ARCHITECTURES, releaseBuildEnvironment } from "./targets";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nodex-windows-release-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

test.each(["stable", "nightly"] as const)(
  "%s bundles include both signed Windows installers and isolated feeds",
  async (channel) => {
    const inputs = makeReleaseFixture(root, channel);
    const identity = fixtureIdentity(channel);
    const output = join(root, "bundle");
    const bundle = assembleReleaseBundle({ ...inputs, outputDirectory: output });
    expect(Object.keys(bundle.architectures).sort()).toEqual([...RELEASE_ARCHITECTURES].sort());
    const installerAssets = bundle.assets.filter(({ role }) => role === "windows-installer");
    expect(installerAssets).toHaveLength(channel === "stable" ? 4 : 2);
    expect(installerAssets.filter(({ name }) => name.includes("latest"))).toHaveLength(
      channel === "stable" ? 2 : 0,
    );
    for (const arch of ["x64", "arm64"]) {
      const bytes = readFileSync(join(output, `Nodex-${identity.version}-windows-${arch}.exe`));
      if (channel === "stable")
        expect(readFileSync(join(output, `Nodex-latest-windows-${arch}.exe`))).toEqual(bytes);
      const xml = readFileSync(
        join(output, `Nodex-${identity.version}-appcast-windows-${arch}.xml`),
        "utf8",
      );
      expect(xml).toContain(`sparkle:os="windows"`);
      expect(xml).toContain(
        `/releases/download/${identity.tag}/Nodex-${identity.version}-windows-${arch}.exe`,
      );
    }
    const bundlePath = join(output, "release-bundle.json");
    const assetNames = releaseAssetPaths(bundlePath, inputs.windowsPublicKey).map((path) =>
      basename(path),
    );
    for (const asset of installerAssets) expect(assetNames).toContain(asset.name);
    const site = join(root, "site");
    const otherChannel = channel === "stable" ? "nightly" : "stable";
    const preserved = join(site, `updates/${otherChannel}/windows-x64/appcast.xml`);
    mkdirSync(dirname(preserved), { recursive: true });
    writeFileSync(preserved, "other-channel");
    const projection = projectReleaseAppcasts({
      bundlePath,
      siteDirectory: site,
      existingSiteDirectory: site,
      windowsPublicKey: inputs.windowsPublicKey,
    });
    expect(projection.feeds.map(({ path }) => path).sort()).toEqual(
      RELEASE_ARCHITECTURES.map((arch) => `updates/${channel}/${arch}/appcast.xml`).sort(),
    );
    for (const feed of projection.feeds)
      expect(sha256File(join(site, feed.path))).toBe(feed.sha256);
    expect(readFileSync(preserved, "utf8")).toBe("other-channel");
    // An idempotent retry still verifies the public canonical feed and every enclosure.
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      const arch = RELEASE_ARCHITECTURES.find((arch) =>
        new URL(url).pathname.endsWith(`/${arch}/appcast.xml`),
      );
      return new Response(
        readFileSync(join(output, `Nodex-${identity.version}-appcast-${arch}.xml`), "utf8"),
      );
    });
    vi.stubGlobal("fetch", fetch);
    await verifyPublishedAppcasts({
      bundlePath,
      windowsPublicKey: inputs.windowsPublicKey,
      attempts: 1,
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(3);
  },
);

test("rejects a missing Windows architecture, disabled update channel, or mismatched runtime lock", () => {
  const inputs = makeReleaseFixture(root);
  const path = join(inputs.windowsX64Directory, "architecture-build.json");
  const build = read(path);
  for (const mutation of [
    { ...build, updates: "disabled" },
    { ...build, runtimeLocks: { ...build.runtimeLocks, agentSha256: "d".repeat(64) } },
    { ...build, sourceTree: "f".repeat(40) },
  ]) {
    write(path, mutation);
    expect(() =>
      assembleReleaseBundle({ ...inputs, outputDirectory: join(root, "output") }),
    ).toThrow();
    rmSync(join(root, "output"), { recursive: true, force: true });
  }
  write(path, build);
  rmSync(inputs.windowsArm64Directory, { recursive: true });
  expect(() =>
    assembleReleaseBundle({ ...inputs, outputDirectory: join(root, "output") }),
  ).toThrow();
});

test("rejects signatures from another key and content tampering even when hashes are rewritten", () => {
  const inputs = makeReleaseFixture(root);
  const identity = fixtureIdentity();
  const { privateKey } = generateKeyPairSync("ed25519");
  const updatePath = join(
    inputs.windowsX64UpdateDirectory,
    `Nodex-${identity.version}-update-windows-x64.json`,
  );
  const update = read(updatePath);
  const installer = join(inputs.windowsX64Directory, update.full.name);
  write(updatePath, {
    ...update,
    full: {
      ...update.full,
      edSignature: sign(null, readFileSync(installer), privateKey).toString("base64"),
    },
  });
  expect(() =>
    assembleReleaseBundle({ ...inputs, outputDirectory: join(root, "bad-key") }),
  ).toThrow("Invalid Ed25519 signature");
  write(updatePath, update);
  const appcastPath = join(inputs.windowsX64UpdateDirectory, update.appcast.name);
  appendFileSync(appcastPath, "\n<!--tampered-->");
  write(updatePath, {
    ...update,
    appcast: {
      ...update.appcast,
      bytes: readFileSync(appcastPath).length,
      sha256: sha256File(appcastPath),
    },
  });
  expect(() =>
    assembleReleaseBundle({ ...inputs, outputDirectory: join(root, "bad-feed") }),
  ).toThrow("Invalid Ed25519 signature");
});

test("preflights every feed before projecting, rejecting rollback and same-build byte drift", () => {
  const inputs = makeReleaseFixture(root);
  const output = join(root, "bundle");
  assembleReleaseBundle({ ...inputs, outputDirectory: output });
  const bundlePath = join(output, "release-bundle.json");
  for (const buildVersion of ["2.0.0", "1.0.1"]) {
    const site = join(root, buildVersion);
    const feed = join(site, "updates/stable/windows-arm64/appcast.xml");
    mkdirSync(dirname(feed), { recursive: true });
    writeFileSync(
      feed,
      `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>${buildVersion}</sparkle:version></item></channel></rss>`,
    );
    expect(() =>
      projectReleaseAppcasts({
        bundlePath,
        existingSiteDirectory: site,
        siteDirectory: site,
        windowsPublicKey: inputs.windowsPublicKey,
      }),
    ).toThrow(buildVersion === "2.0.0" ? "cannot move" : "different bytes");
    expect(existsSync(join(site, "updates/stable/arm64/appcast.xml"))).toBe(false);
  }
});

test("bundle admission requires every Windows asset and byte-identical stable aliases", () => {
  const inputs = makeReleaseFixture(root);
  const bundle = assembleReleaseBundle({ ...inputs, outputDirectory: join(root, "bundle") });
  expect(() =>
    parseReleaseBundleManifest({
      ...bundle,
      assets: bundle.assets.filter(({ name }) => name !== "Nodex-latest-windows-arm64.exe"),
    }),
  ).toThrow("missing");
  expect(() =>
    parseReleaseBundleManifest({
      ...bundle,
      assets: bundle.assets.map((asset) =>
        asset.name === "Nodex-latest-windows-x64.exe"
          ? { ...asset, sha256: "a".repeat(64) }
          : asset,
      ),
    }),
  ).toThrow("identical bytes");
});

test("rejects Windows update projection and identity substitutions", () => {
  const inputs = makeReleaseFixture(root);
  const manifest = read(
    join(inputs.windowsX64UpdateDirectory, "Nodex-0.2.2-update-windows-x64.json"),
  );
  for (const mutation of [
    {
      ...manifest,
      appcast: { ...manifest.appcast, feedPath: "updates/stable/windows-arm64/appcast.xml" },
    },
    {
      ...manifest,
      full: {
        ...manifest.full,
        url: manifest.full.url.replace("/download/v0.2.2/", "/latest/download/"),
      },
    },
    { ...manifest, target: { ...manifest.target, buildVersion: "2.0.0" } },
    { ...manifest, deltas: [manifest.full] },
  ])
    expect(() => parseWindowsArchitectureUpdateManifest(mutation)).toThrow();
});

test("distribution passes channel-neutral build metadata to both platforms", () => {
  const identity = fixtureIdentity("nightly");
  expect(releaseBuildEnvironment(identity, "/identity.json")).toMatchObject({
    NODEX_BUILD_IDENTITY_PATH: "/identity.json",
    NODEX_BUILD_VERSION: identity.buildVersion,
    NODEX_APP_UPDATES: "enabled",
    SENTRY_RELEASE: `nodex@${identity.version}+${identity.buildVersion}`,
  });
});

test("recovery rejects forged Windows signatures even with a self-consistent bundle checksum tree", () => {
  const inputs = makeReleaseFixture(root);
  const output = join(root, "bundle");
  const bundle = assembleReleaseBundle({ ...inputs, outputDirectory: output });
  const bundlePath = join(output, "release-bundle.json");
  const updateName = "Nodex-0.2.2-update-windows-x64.json";
  const updatePath = join(output, updateName);
  const update = read(updatePath);
  write(updatePath, { ...update, full: { ...update.full, edSignature: `${"A".repeat(86)}==` } });
  const forged = {
    ...bundle,
    architectures: {
      ...bundle.architectures,
      "windows-x64": {
        ...bundle.architectures["windows-x64"],
        updateManifestSha256: sha256File(updatePath),
      },
    },
    assets: bundle.assets.map((asset) =>
      asset.name === updateName
        ? { ...asset, bytes: readFileSync(updatePath).length, sha256: sha256File(updatePath) }
        : asset,
    ),
  };
  write(bundlePath, forged);
  const checksums = [
    ...forged.assets,
    { name: "release-bundle.json", sha256: sha256File(bundlePath) },
  ].sort((left, right) => left.name.localeCompare(right.name));
  writeFileSync(
    join(output, "SHA256SUMS"),
    `${checksums.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n")}\n`,
  );
  expect(() => releaseAssetPaths(bundlePath, inputs.windowsPublicKey)).toThrow(
    "Invalid Ed25519 signature",
  );
});
