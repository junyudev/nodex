import { mkdirSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DOMImplementation, XMLSerializer } from "@xmldom/xmldom";
import type { WindowsArchitecture } from "../desktop-build-target";
import { materializeSparkleRuntime } from "../materialize-sparkle-runtime";
import {
  publicationIdentity,
  parseReleaseIdentity,
  sha256File,
  type ReleaseIdentity,
} from "./model";
import { readArchitectureDirectory, type ReleaseBundleManifest } from "./bundle";
import { verifySparkleAppcastContract } from "./sparkle-appcast-contract";
import { parseSparkleFileIdentity, type SparkleFileIdentity } from "./sparkle-manifest";
import {
  assertPrivateKeyMatchesPublicKey,
  readConfiguredPublicKey,
  runWithPrivateKey,
  signFile,
  verifyFileSignature,
} from "./signing";
import { windowsInstallerName, type WindowsReleaseArchitecture } from "./targets";

const SPARKLE_NAMESPACE = "http://www.andymatuschak.org/xml-namespaces/sparkle";

export interface WindowsArchitectureUpdateManifest {
  readonly schemaVersion: 1;
  readonly architecture: WindowsReleaseArchitecture;
  readonly releaseIdentity: ReleaseIdentity;
  readonly channel: ReleaseIdentity["channel"];
  readonly sourceSha: string;
  readonly tag: string;
  readonly target: { readonly version: string; readonly buildVersion: string };
  readonly full: SparkleFileIdentity;
  readonly deltas: readonly [];
  readonly appcast: {
    readonly name: string;
    readonly feedPath: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly edSignature: string;
  };
}

const requireShape = (value: unknown, keys: readonly string[]): void => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    throw new Error("Windows update manifest has an unsupported shape.");
  }
};

export function parseWindowsArchitectureUpdateManifest(
  value: unknown,
): WindowsArchitectureUpdateManifest {
  requireShape(value, [
    "schemaVersion",
    "architecture",
    "releaseIdentity",
    "channel",
    "sourceSha",
    "tag",
    "target",
    "full",
    "deltas",
    "appcast",
  ]);
  const candidate = value as WindowsArchitectureUpdateManifest;
  const identity = parseReleaseIdentity(candidate.releaseIdentity);
  requireShape(candidate.target, ["version", "buildVersion"]);
  requireShape(candidate.appcast, ["name", "feedPath", "bytes", "sha256", "edSignature"]);
  if (
    candidate.schemaVersion !== 1 ||
    (candidate.architecture !== "windows-x64" && candidate.architecture !== "windows-arm64") ||
    candidate.channel !== identity.channel ||
    candidate.sourceSha !== identity.sourceSha ||
    candidate.tag !== identity.tag ||
    candidate.target?.version !== identity.version ||
    candidate.target.buildVersion !== identity.buildVersion ||
    !Array.isArray(candidate.deltas) ||
    candidate.deltas.length !== 0
  )
    throw new Error("Windows update manifest does not match its Release Identity.");
  const architecture = candidate.architecture === "windows-x64" ? "x64" : "arm64";
  const full = parseSparkleFileIdentity(candidate.full, identity.tag, "Windows installer");
  const appcastName = `Nodex-${identity.version}-appcast-${candidate.architecture}.xml`;
  const appcast = candidate.appcast;
  if (
    full.name !== windowsInstallerName(identity.version, architecture) ||
    !appcast ||
    appcast.name !== appcastName ||
    appcast.feedPath !== `updates/${identity.channel}/${candidate.architecture}/appcast.xml` ||
    !Number.isSafeInteger(appcast.bytes) ||
    appcast.bytes <= 0 ||
    !/^[a-f0-9]{64}$/u.test(appcast.sha256) ||
    !/^[A-Za-z0-9+/]{86}==$/u.test(appcast.edSignature)
  )
    throw new Error("Windows update assets do not match their release and feed paths.");
  return { ...candidate, releaseIdentity: identity, full };
}

/** The finalizer uses sign_update; tests supply an independent generated Ed25519 key. */
export function createWindowsArchitectureUpdate(options: {
  readonly architecture: WindowsArchitecture;
  readonly identity: ReleaseIdentity;
  readonly installerPath: string;
  readonly outputDirectory: string;
  readonly publishedAt: string;
  readonly releaseNotes: string;
  readonly publicKey: string;
  readonly sign: (filePath: string) => string;
  readonly sealAppcast: (filePath: string) => void;
}): WindowsArchitectureUpdateManifest {
  const identity = parseReleaseIdentity(options.identity);
  const architecture = `windows-${options.architecture}` as const;
  const output = resolve(options.outputDirectory);
  if (existsSync(output) && readdirSync(output).length > 0)
    throw new Error("Windows update output must be empty.");
  mkdirSync(output, { recursive: true });
  const pubDate = new Date(options.publishedAt);
  if (Number.isNaN(pubDate.valueOf()))
    throw new Error("Windows update publication date is invalid.");
  const name = windowsInstallerName(identity.version, options.architecture);
  const full: SparkleFileIdentity = {
    bytes: statSync(options.installerPath).size,
    edSignature: options.sign(options.installerPath),
    name,
    sha256: sha256File(options.installerPath),
    url: `https://github.com/junyudev/nodex/releases/download/${identity.tag}/${encodeURIComponent(name)}`,
  };
  verifyFileSignature(options.installerPath, full.edSignature, options.publicKey);
  const document = new DOMImplementation().createDocument(null, "rss", null);
  const rss = document.documentElement!;
  rss.setAttribute("version", "2.0");
  rss.setAttribute("xmlns:sparkle", SPARKLE_NAMESPACE);
  const channel = document.createElement("channel");
  rss.appendChild(channel);
  const text = (parent: typeof rss, tag: string, value: string): void => {
    const node = tag.startsWith("sparkle:")
      ? document.createElementNS(SPARKLE_NAMESPACE, tag)
      : document.createElement(tag);
    node.appendChild(document.createTextNode(value));
    parent.appendChild(node);
  };
  text(channel, "title", "Nodex");
  text(channel, "link", "https://nodex.jyu.app/");
  const item = document.createElement("item");
  channel.appendChild(item);
  text(item, "title", `Nodex ${identity.version}`);
  text(item, "sparkle:version", identity.buildVersion);
  text(item, "sparkle:shortVersionString", identity.version);
  text(item, "pubDate", pubDate.toUTCString());
  text(item, "description", options.releaseNotes);
  const enclosure = document.createElement("enclosure");
  enclosure.setAttribute("url", full.url);
  enclosure.setAttribute("length", String(full.bytes));
  enclosure.setAttribute("type", "application/octet-stream");
  enclosure.setAttributeNS(SPARKLE_NAMESPACE, "sparkle:os", "windows");
  enclosure.setAttributeNS(SPARKLE_NAMESPACE, "sparkle:edSignature", full.edSignature);
  item.appendChild(enclosure);
  const appcastName = `Nodex-${identity.version}-appcast-${architecture}.xml`;
  const appcastPath = join(output, appcastName);
  writeFileSync(
    appcastPath,
    `<?xml version="1.0" encoding="utf-8"?>\n${new XMLSerializer().serializeToString(document)}\n`,
  );
  options.sealAppcast(appcastPath);
  const appcastSignature = options.sign(appcastPath);
  verifyFileSignature(appcastPath, appcastSignature, options.publicKey);
  const manifest = parseWindowsArchitectureUpdateManifest({
    schemaVersion: 1,
    architecture,
    releaseIdentity: identity,
    channel: identity.channel,
    sourceSha: identity.sourceSha,
    tag: identity.tag,
    target: { version: identity.version, buildVersion: identity.buildVersion },
    full,
    deltas: [],
    appcast: {
      name: appcastName,
      feedPath: `updates/${identity.channel}/${architecture}/appcast.xml`,
      bytes: statSync(appcastPath).size,
      sha256: sha256File(appcastPath),
      edSignature: appcastSignature,
    },
  });
  verifySparkleAppcastContract(readFileSync(appcastPath, "utf8"), manifest);
  writeFileSync(
    join(output, `Nodex-${identity.version}-update-${architecture}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function finalizeWindowsArchitectureUpdate(options: {
  readonly architecture: WindowsArchitecture;
  readonly architectureDirectory: string;
  readonly outputDirectory: string;
  readonly privateKey: string;
  readonly publishedAt: string;
  readonly releaseNotesPath: string;
  readonly sourceSha: string;
  readonly channel: ReleaseIdentity["channel"];
  readonly version: string;
}): Promise<WindowsArchitectureUpdateManifest> {
  if (process.platform !== "darwin")
    throw new Error("Windows update finalization requires macOS Sparkle tools.");
  if (!options.privateKey.trim()) throw new Error("Sparkle private key is required.");
  const build = readArchitectureDirectory(options.architectureDirectory);
  if (
    build.architecture !== `windows-${options.architecture}` ||
    build.updates !== "enabled" ||
    build.sourceSha !== options.sourceSha ||
    build.version !== options.version
  )
    throw new Error("Windows finalizer inputs do not match the architecture build.");
  const toolchain = resolve(".generated/sparkle-toolchain/2.9.4");
  await materializeSparkleRuntime({ outputPath: toolchain });
  const signUpdate = join(toolchain, "bin/sign_update");
  const publicKey = readConfiguredPublicKey();
  assertPrivateKeyMatchesPublicKey(signUpdate, options.privateKey, publicKey);
  return createWindowsArchitectureUpdate({
    ...options,
    identity: publicationIdentity(build.buildIdentity, options.channel),
    publicKey,
    installerPath: join(
      resolve(options.architectureDirectory),
      windowsInstallerName(build.version, options.architecture),
    ),
    releaseNotes: readFileSync(options.releaseNotesPath, "utf8"),
    sign: (filePath) => signFile(signUpdate, filePath, options.privateKey),
    sealAppcast: (filePath) => {
      runWithPrivateKey(
        signUpdate,
        ["--ed-key-file", "-", "--disable-signing-warning", filePath],
        options.privateKey,
      );
      runWithPrivateKey(
        signUpdate,
        ["--verify", "--ed-key-file", "-", filePath],
        options.privateKey,
      );
    },
  });
}

/** Recovery and promotion admit the same signed Windows closure as initial assembly. */
export function verifyWindowsReleaseAssets(
  bundle: ReleaseBundleManifest,
  root: string,
  publicKey = readConfiguredPublicKey(),
): void {
  for (const architecture of ["windows-x64", "windows-arm64"] as const) {
    const name = `Nodex-${bundle.version}-update-${architecture}.json`;
    const manifest = parseWindowsArchitectureUpdateManifest(
      JSON.parse(readFileSync(join(root, name), "utf8")),
    );
    if (
      manifest.architecture !== architecture ||
      !isDeepStrictEqual(manifest.releaseIdentity, bundle.releaseIdentity) ||
      bundle.architectures[architecture].updateManifestSha256 !== sha256File(join(root, name))
    )
      throw new Error("Windows update manifest is not bound by the Release Bundle.");
    for (const identity of [manifest.full, manifest.appcast]) {
      const asset = bundle.assets.find(({ name }) => name === identity.name);
      if (
        !asset ||
        asset.architecture !== architecture ||
        asset.bytes !== identity.bytes ||
        asset.sha256 !== identity.sha256
      )
        throw new Error("Windows update assets are not bound by the Release Bundle.");
      verifyFileSignature(join(root, identity.name), identity.edSignature, publicKey);
    }
    verifySparkleAppcastContract(readFileSync(join(root, manifest.appcast.name), "utf8"), manifest);
  }
}
