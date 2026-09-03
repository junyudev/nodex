import { createHash, randomUUID, verify as verifySignature } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { createBrowserUsePeerAuthorizer } from "../../src/main/browser-use/browser-use-peer-authorizer";
import {
  BrowserUseNativePipeFrameDecoder,
  encodeBrowserUseNativePipeFrame,
} from "../../src/main/browser-use/native-pipe-framing";
import {
  loadChromeBrowserAuthority,
  type ChromeBrowserAuthority,
} from "../../src/main/browser-use/chrome/ChromeBrowserFamilyRegistry";
import {
  ChromeExtensionPipeRegistry,
  isSafeChromeExtensionSocketDirectoryMetadata,
  type ChromeExtensionPipeRegistrySnapshot,
  type ChromeNativeHostPeerIdentity,
} from "../../src/main/browser-use/chrome/ChromeExtensionPipeRegistry";
import {
  installChromeNativeHost,
  readChromeNativeHostIdentity,
} from "../../src/main/browser-use/chrome/ChromeNativeHostInstaller";
import {
  BROWSER_PLUGIN_NODE_MODULE_DIR,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  isSafeBrowserRuntimeRelativePath,
  parseBrowserRuntimeManifest,
  type BrowserRuntimeArtifact,
  type BrowserRuntimeManifest,
} from "../../src/shared/browser-runtime-metadata";

const OPT_IN_ENV = "NODEX_CHROME_CONTROL_E2E";
const RUNTIME_ROOT_ENV = "NODEX_CHROME_CONTROL_E2E_RUNTIME_ROOT";
const EXTENSION_CRX_ENV = "NODEX_CHROME_CONTROL_E2E_EXTENSION_CRX";
const BROWSER_EXECUTABLE_ENV = "NODEX_CHROME_CONTROL_E2E_BROWSER_EXECUTABLE";
const EVIDENCE_PATH_ENV = "NODEX_CHROME_CONTROL_E2E_EVIDENCE_PATH";
const REEXEC_ENV = "NODEX_CHROME_CONTROL_E2E_SIGNED_NODE";
const SOCKET_DIRECTORY = "/tmp/codex-browser-use";
const REQUEST_TIMEOUT_MS = 2_000;
const RUN_TIMEOUT_MS = 20_000;
const MAX_CRX_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export type ChromeControlDisposableE2EConfig = {
  readonly browserExecutable: string;
  readonly evidencePath: string;
  readonly extensionCrx: string;
  readonly runtimeRoot: string;
};

export type ChromeControlDisposableE2EGate =
  | { readonly reason: "explicit-opt-in-required"; readonly status: "skipped" }
  | { readonly config: ChromeControlDisposableE2EConfig; readonly status: "ready" };

type ProtoField = {
  readonly bytes?: Buffer;
  readonly fieldNumber: number;
  readonly wireType: number;
};

export type VerifiedCrx3 = {
  readonly extensionId: string;
  readonly publicKey: Buffer;
  readonly zipBytes: Buffer;
};

type ChromeRuntimeSelection = {
  readonly authority: ChromeBrowserAuthority;
  readonly criticalArtifacts: readonly BrowserRuntimeArtifact[];
  readonly manifest: BrowserRuntimeManifest;
  readonly manifestSha256: string;
  readonly paths: {
    readonly browserClient: string;
    readonly browserService: string;
    readonly codexCli: string;
    readonly familyDescriptor: string;
    readonly nativeHost: string;
    readonly node: string;
    readonly nodeModuleDirs: readonly string[];
    readonly nodeRepl: string;
    readonly peerAuthorization: string;
  };
  readonly root: string;
};

type ExtensionHandshake = {
  readonly ensure: {
    readonly entryId: string;
    readonly hasLocalAppServerUrl: boolean;
    readonly selected: {
      readonly appServerProtocolVersion: number;
      readonly appVersion: string;
      readonly channel: string;
      readonly cliVersion: string;
      readonly nativeHostProtocolVersion: number;
      readonly nativeHostVersion: string;
    };
  };
  readonly hello: {
    readonly manifestSchemaVersion: number;
    readonly nativeHostProtocolVersion: number;
    readonly supportedProtocolVersions: readonly number[];
  };
  readonly runtimeId: string;
};

type WorkerTabPair = {
  readonly firstTabId: number;
  readonly initialActiveTabId: number | null;
  readonly secondTabId: number;
};

type NativePortLike = {
  readonly disconnect: () => void;
  readonly onMessage: {
    readonly addListener: (listener: (message: unknown) => void) => void;
    readonly removeListener: (listener: (message: unknown) => void) => void;
  };
  readonly postMessage: (message: unknown) => void;
};

type ExtensionChromeApi = {
  readonly runtime: {
    readonly connectNative: (hostName: string) => NativePortLike;
    readonly id: string;
  };
  readonly tabs: {
    readonly create: (input: { readonly active: boolean; readonly url: string }) => Promise<{
      readonly id?: number;
    }>;
    readonly query: (input: {
      readonly active: boolean;
      readonly currentWindow: boolean;
    }) => Promise<readonly { readonly id?: number }[]>;
    readonly update: (tabId: number, input: { readonly active: boolean }) => Promise<unknown>;
  };
};

function requiredPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value || value.includes("\0")) throw new Error(`${name} is required for the opt-in gate`);
  return path.resolve(value);
}

/** CI skips unless explicitly opted in; once opted in, every local input is mandatory. */
export function resolveChromeControlDisposableE2EGate(
  env: NodeJS.ProcessEnv,
): ChromeControlDisposableE2EGate {
  if (env[OPT_IN_ENV] === undefined) {
    return { reason: "explicit-opt-in-required", status: "skipped" };
  }
  if (env[OPT_IN_ENV] !== "1") {
    throw new Error(`${OPT_IN_ENV} must be exactly 1 when set`);
  }
  return {
    config: {
      browserExecutable: requiredPath(env, BROWSER_EXECUTABLE_ENV),
      evidencePath: requiredPath(env, EVIDENCE_PATH_ENV),
      extensionCrx: requiredPath(env, EXTENSION_CRX_ENV),
      runtimeRoot: requiredPath(env, RUNTIME_ROOT_ENV),
    },
    status: "ready",
  };
}

function readVarint(
  bytes: Buffer,
  initialOffset: number,
): { readonly offset: number; readonly value: number } {
  let offset = initialOffset;
  let shift = 0;
  let value = 0;
  while (offset < bytes.length && shift <= 49) {
    const byte = bytes[offset];
    if (byte === undefined) break;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new Error("CRX3 protobuf integer is too large");
      return { offset, value };
    }
    shift += 7;
  }
  throw new Error("CRX3 protobuf varint is invalid");
}

function parseProtoFields(bytes: Buffer): readonly ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (fieldNumber <= 0) throw new Error("CRX3 protobuf field number is invalid");
    if (wireType === 0) {
      offset = readVarint(bytes, offset).offset;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > bytes.length) throw new Error("CRX3 protobuf field exceeds its message");
      fields.push({ bytes: bytes.subarray(offset, end), fieldNumber, wireType });
      offset = end;
      continue;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error("CRX3 protobuf wire type is unsupported");
    }
    if (offset > bytes.length) throw new Error("CRX3 protobuf field exceeds its message");
    fields.push({ fieldNumber, wireType });
  }
  return fields;
}

export function deriveChromeExtensionId(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest().subarray(0, 16);
  let extensionId = "";
  for (const byte of digest) {
    extensionId += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return extensionId;
}

function requireSingleBytes(
  fields: readonly ProtoField[],
  fieldNumber: number,
  label: string,
): Buffer {
  const values = fields
    .filter((field) => field.fieldNumber === fieldNumber && field.wireType === 2)
    .flatMap((field) => (field.bytes ? [field.bytes] : []));
  if (values.length !== 1 || !values[0]) throw new Error(`${label} is missing or duplicated`);
  return values[0];
}

/** Verifies the CRX3 proof over the complete ZIP payload before exposing extension content. */
export function verifyCrx3(bytes: Buffer, allowedExtensionIds: readonly string[]): VerifiedCrx3 {
  if (bytes.length < 16 || bytes.subarray(0, 4).toString("ascii") !== "Cr24") {
    throw new Error("Extension package is not a CRX file");
  }
  if (bytes.readUInt32LE(4) !== 3) throw new Error("Extension package is not CRX3");
  const headerLength = bytes.readUInt32LE(8);
  const zipOffset = 12 + headerLength;
  if (headerLength <= 0 || zipOffset >= bytes.length || headerLength > 16 * 1024 * 1024) {
    throw new Error("CRX3 header length is invalid");
  }

  const headerFields = parseProtoFields(bytes.subarray(12, zipOffset));
  const signedHeader = requireSingleBytes(headerFields, 10_000, "CRX3 signed header");
  const signedHeaderFields = parseProtoFields(signedHeader);
  const signedCrxId = requireSingleBytes(signedHeaderFields, 1, "CRX3 signed extension ID");
  if (signedCrxId.length !== 16) throw new Error("CRX3 signed extension ID is invalid");
  const zipBytes = bytes.subarray(zipOffset);
  if (zipBytes.subarray(0, 2).toString("ascii") !== "PK") {
    throw new Error("CRX3 payload is not a ZIP archive");
  }
  const signedHeaderLength = Buffer.alloc(4);
  signedHeaderLength.writeUInt32LE(signedHeader.length);
  const signedPayload = Buffer.concat([
    Buffer.from("CRX3 SignedData\0", "binary"),
    signedHeaderLength,
    signedHeader,
    zipBytes,
  ]);

  for (const proofField of headerFields.filter(
    (field) => (field.fieldNumber === 2 || field.fieldNumber === 3) && field.wireType === 2,
  )) {
    if (!proofField.bytes) continue;
    const proof = parseProtoFields(proofField.bytes);
    const publicKey = requireSingleBytes(proof, 1, "CRX3 proof public key");
    const signature = requireSingleBytes(proof, 2, "CRX3 proof signature");
    const extensionId = deriveChromeExtensionId(publicKey);
    if (!allowedExtensionIds.includes(extensionId)) continue;
    if (!createHash("sha256").update(publicKey).digest().subarray(0, 16).equals(signedCrxId)) {
      throw new Error("CRX3 proof key does not match its signed extension ID");
    }
    const verified = verifySignature(
      "sha256",
      signedPayload,
      { format: "der", key: publicKey, type: "spki" },
      signature,
    );
    if (!verified) throw new Error("CRX3 signature verification failed");
    return { extensionId, publicKey, zipBytes };
  }
  throw new Error("CRX3 has no valid proof for an attested extension ID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function openRegularFile(filePath: string): Promise<fs.FileHandle> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const stats = await handle.stat();
  if (!stats.isFile()) {
    await handle.close();
    throw new Error(`Expected a regular file: ${filePath}`);
  }
  return handle;
}

async function readBoundedRegularFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const handle = await openRegularFile(filePath);
  try {
    const stats = await handle.stat();
    if (stats.size > maximumBytes) throw new Error(`File exceeds its bound: ${filePath}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function hashRegularFile(
  filePath: string,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const handle = await openRegularFile(filePath);
  try {
    const stats = await handle.stat();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return { sha256: hash.digest("hex"), size: stats.size };
  } finally {
    await handle.close();
  }
}

async function requireDirectory(directory: string): Promise<string> {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Expected a non-symlink directory: ${directory}`);
  }
  return await fs.realpath(directory);
}

async function requireRuntimeDirectory(root: string, relativePath: string): Promise<string> {
  if (!isSafeBrowserRuntimeRelativePath(relativePath)) {
    throw new Error(`Runtime directory path is unsafe: ${relativePath}`);
  }
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Runtime directory is invalid: ${relativePath}`);
    }
  }
  return current;
}

async function verifyRuntimeArtifact(
  root: string,
  artifact: BrowserRuntimeArtifact,
): Promise<string> {
  const segments = artifact.path.split("/");
  if (segments.length > 1) {
    await requireRuntimeDirectory(root, segments.slice(0, -1).join("/"));
  }
  const artifactPath = path.join(root, ...segments);
  const stats = await fs.lstat(artifactPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Runtime artifact is not a regular file: ${artifact.path}`);
  }
  if (artifact.executable && (stats.mode & 0o111) === 0) {
    throw new Error(`Runtime artifact is not executable: ${artifact.path}`);
  }
  const actual = await hashRegularFile(artifactPath);
  if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256) {
    throw new Error(`Runtime artifact failed manifest verification: ${artifact.path}`);
  }
  return artifactPath;
}

function findArtifact(
  manifest: BrowserRuntimeManifest,
  relativePath: string,
): BrowserRuntimeArtifact {
  const matches = manifest.artifacts.filter((artifact) => artifact.path === relativePath);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`Runtime manifest has no unique artifact for ${relativePath}`);
  }
  return matches[0];
}

async function loadRuntimeSelection(runtimeRootInput: string): Promise<ChromeRuntimeSelection> {
  if (process.platform !== "darwin") throw new Error("Disposable Chrome gate requires macOS");
  const root = await requireDirectory(runtimeRootInput);
  const manifestPath = path.join(root, BROWSER_RUNTIME_MANIFEST_FILENAME);
  const manifestBytes = await readBoundedRegularFile(manifestPath, 16 * 1024 * 1024);
  const manifest = parseBrowserRuntimeManifest(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
  );
  if (!manifest) throw new Error("Browser runtime manifest is invalid");
  if (manifest.targetPlatform !== "darwin" || manifest.targetArch !== process.arch) {
    throw new Error("Runtime manifest does not match the active macOS architecture");
  }
  const chrome = manifest.capabilities.browserUse.backends.chrome;
  if (chrome.status !== "available") throw new Error("Chrome runtime capability is unavailable");

  const criticalRelativePaths = [
    manifest.entrypoints.codexCli,
    manifest.entrypoints.node,
    manifest.entrypoints.nodeRepl,
    manifest.entrypoints.peerAuthorization,
    manifest.browserPlugin.client,
    manifest.browserPlugin.service,
    chrome.familyDescriptor,
    chrome.nativeHost.path,
    chrome.plugin.manifest,
  ];
  const criticalArtifacts = [...new Set(criticalRelativePaths)].map((relativePath) =>
    findArtifact(manifest, relativePath),
  );
  const verified = new Map<string, string>();
  for (const artifact of criticalArtifacts) {
    verified.set(artifact.path, await verifyRuntimeArtifact(root, artifact));
  }
  const nativeHostNodeModulePaths = manifest.browserPlugin.nodeModuleDirs.filter(
    (relativePath) => relativePath !== BROWSER_PLUGIN_NODE_MODULE_DIR,
  );
  if (nativeHostNodeModulePaths.length !== 1) {
    throw new Error("Runtime manifest has no unique native-host Node module directory");
  }
  const nodeModuleDirs = await Promise.all(
    nativeHostNodeModulePaths.map((relativePath) => requireRuntimeDirectory(root, relativePath)),
  );
  const descriptorArtifact = findArtifact(manifest, chrome.familyDescriptor);
  const authority = await loadChromeBrowserAuthority({
    descriptorPath: verified.get(chrome.familyDescriptor)!,
    expectedExtensionIds: chrome.extensionIds,
    expectedHostName: chrome.nativeHost.hostName,
    expectedSha256: descriptorArtifact.sha256,
    expectedSize: descriptorArtifact.size,
  });
  return {
    authority,
    criticalArtifacts,
    manifest,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    paths: {
      browserClient: verified.get(manifest.browserPlugin.client)!,
      browserService: verified.get(manifest.browserPlugin.service)!,
      codexCli: verified.get(manifest.entrypoints.codexCli)!,
      familyDescriptor: verified.get(chrome.familyDescriptor)!,
      nativeHost: verified.get(chrome.nativeHost.path)!,
      node: verified.get(manifest.entrypoints.node)!,
      nodeModuleDirs,
      nodeRepl: verified.get(manifest.entrypoints.nodeRepl)!,
      peerAuthorization: verified.get(manifest.entrypoints.peerAuthorization)!,
    },
    root,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function inspectExtractedTree(root: string): Promise<void> {
  const canonicalRoot = await fs.realpath(root);
  const pending: Array<{ readonly depth: number; readonly path: string }> = [
    { depth: 0, path: root },
  ];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.depth > 64) throw new Error("Extension archive nesting is too deep");
    for (const entry of await fs.readdir(current.path, { withFileTypes: true })) {
      entries += 1;
      if (entries > 50_000) throw new Error("Extension archive contains too many entries");
      const entryPath = path.join(current.path, entry.name);
      const stats = await fs.lstat(entryPath);
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        throw new Error("Extension archive contains an unsafe filesystem entry");
      }
      const canonical = await fs.realpath(entryPath);
      if (!canonical.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new Error("Extension archive escaped its disposable root");
      }
      if (stats.isDirectory()) pending.push({ depth: current.depth + 1, path: entryPath });
    }
  }
}

async function extractVerifiedExtension(
  crxPath: string,
  extensionRoot: string,
  allowedExtensionIds: readonly string[],
): Promise<{
  readonly crxSha256: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
}> {
  const crxBytes = await readBoundedRegularFile(crxPath, MAX_CRX_BYTES);
  const verifiedCrx = verifyCrx3(crxBytes, allowedExtensionIds);
  const archivePath = path.join(path.dirname(extensionRoot), "extension.zip");
  await fs.writeFile(archivePath, verifiedCrx.zipBytes, { flag: "wx", mode: 0o600 });
  await fs.mkdir(extensionRoot, { mode: 0o700 });
  const result = spawnSync("/usr/bin/ditto", ["-x", "-k", archivePath, extensionRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Failed to extract the verified CRX3 payload");
  await inspectExtractedTree(extensionRoot);

  const manifestPath = path.join(extensionRoot, "manifest.json");
  const manifestBytes = await readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (
    !isRecord(manifest) ||
    manifest.manifest_version !== 3 ||
    typeof manifest.version !== "string" ||
    !Array.isArray(manifest.permissions) ||
    !manifest.permissions.includes("nativeMessaging") ||
    !isRecord(manifest.background) ||
    typeof manifest.background.service_worker !== "string"
  ) {
    throw new Error("Verified extension manifest lacks the required MV3 native host contract");
  }
  const patchedManifest = { ...manifest, key: verifiedCrx.publicKey.toString("base64") };
  await fs.writeFile(manifestPath, `${JSON.stringify(patchedManifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    crxSha256: createHash("sha256").update(crxBytes).digest("hex"),
    extensionId: verifiedCrx.extensionId,
    extensionVersion: manifest.version,
  };
}

async function requireChromeForTesting(executablePath: string): Promise<string> {
  const stats = await fs.lstat(executablePath);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111) === 0) {
    throw new Error("Browser executable must be an explicit regular executable");
  }
  const result = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const version = String(result.stdout ?? "").trim();
  if (result.status !== 0 || !/^Google Chrome for Testing\b/u.test(version)) {
    throw new Error("Disposable Chrome gate accepts only Google Chrome for Testing");
  }
  return version;
}

async function listSocketNamesIfSafe(): Promise<readonly string[]> {
  let stats;
  try {
    stats = await fs.lstat(SOCKET_DIRECTORY);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !isSafeChromeExtensionSocketDirectoryMetadata(stats, process.getuid?.())
  ) {
    throw new Error("Official Chrome socket directory has unsafe metadata");
  }
  return (await fs.readdir(SOCKET_DIRECTORY)).sort();
}

async function waitForNewSocketNames(before: ReadonlySet<string>): Promise<readonly string[]> {
  const deadline = Date.now() + 10_000;
  let found: readonly string[] = [];
  while (Date.now() < deadline) {
    found = (await listSocketNamesIfSafe()).filter((name) => !before.has(name));
    if (found.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return (await listSocketNamesIfSafe()).filter((name) => !before.has(name));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Extension handshake created no new browser-use socket");
}

async function waitForExtensionWorker(
  context: BrowserContext,
  extensionId: string,
): Promise<Worker> {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    const current = context.serviceWorkers().find((worker) => worker.url().startsWith(prefix));
    if (current) return current;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Attested extension service worker did not load");
    const worker = await context
      .waitForEvent("serviceworker", {
        timeout: Math.min(remaining, 2_000),
      })
      .catch(() => null);
    if (worker?.url().startsWith(prefix)) return worker;
  }
}

async function performExtensionHandshake(
  worker: Worker,
  input: {
    readonly extensionId: string;
    readonly extensionVersion: string;
    readonly hostName: string;
  },
): Promise<ExtensionHandshake> {
  return await worker.evaluate(async ({ extensionId, extensionVersion, hostName }) => {
    const chromeApi = (globalThis as unknown as { readonly chrome: ExtensionChromeApi }).chrome;
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const constraints = {
      extensionBuildChannel: "prod",
      extensionId,
      extensionVersion,
      nativeHostName: hostName,
      requiredAppServerProtocolVersion: 2,
      requiredNativeHostProtocolVersion: 2,
    };
    const request = async (
      port: NativePortLike,
      id: string,
      method: string,
      params: unknown,
    ): Promise<unknown> =>
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
        const listener = (message: unknown): void => {
          if (!record(message) || String(message.id) !== id) return;
          clearTimeout(timeout);
          port.onMessage.removeListener(listener);
          if (message.error !== undefined) reject(new Error(`${method} failed`));
          else resolve(message.result);
        };
        port.onMessage.addListener(listener);
        port.postMessage({ id, jsonrpc: "2.0", method, params });
      });
    const port = chromeApi.runtime.connectNative(hostName);
    try {
      const helloValue = await request(port, "nodex-hello", "codexRuntime/hello", { constraints });
      const ensureValue = await request(port, "nodex-ensure", "codexRuntime/ensure", {
        constraints,
      });
      if (!record(helloValue) || !record(ensureValue) || !record(ensureValue.selected)) {
        throw new Error("Native host returned an invalid handshake");
      }
      const selected = ensureValue.selected;
      const handshake: ExtensionHandshake = {
        ensure: {
          entryId: String(ensureValue.entryId ?? ""),
          hasLocalAppServerUrl: typeof ensureValue.localAppServerUrl === "string",
          selected: {
            appServerProtocolVersion: Number(selected.appServerProtocolVersion),
            appVersion: String(selected.appVersion ?? ""),
            channel: String(selected.channel ?? ""),
            cliVersion: String(selected.cliVersion ?? ""),
            nativeHostProtocolVersion: Number(selected.nativeHostProtocolVersion),
            nativeHostVersion: String(selected.nativeHostVersion ?? ""),
          },
        },
        hello: {
          manifestSchemaVersion: Number(helloValue.manifestSchemaVersion),
          nativeHostProtocolVersion: Number(helloValue.nativeHostProtocolVersion),
          supportedProtocolVersions: Array.isArray(helloValue.supportedProtocolVersions)
            ? helloValue.supportedProtocolVersions.map(Number)
            : [],
        },
        runtimeId: chromeApi.runtime.id,
      };
      Reflect.set(globalThis, "__nodexDisposableNativePort", port);
      return handshake;
    } catch (error) {
      port.disconnect();
      throw error;
    }
  }, input);
}

async function createTabPair(worker: Worker): Promise<WorkerTabPair> {
  return await worker.evaluate(async () => {
    const chromeApi = (globalThis as unknown as { readonly chrome: ExtensionChromeApi }).chrome;
    const first = await chromeApi.tabs.create({ active: true, url: "about:blank" });
    const second = await chromeApi.tabs.create({ active: false, url: "about:blank" });
    if (first.id === undefined || second.id === undefined)
      throw new Error("Tab IDs are unavailable");
    await chromeApi.tabs.update(first.id, { active: true });
    const active = await chromeApi.tabs.query({ active: true, currentWindow: true });
    return {
      firstTabId: first.id,
      initialActiveTabId: active[0]?.id ?? null,
      secondTabId: second.id,
    };
  });
}

async function readActiveTabId(worker: Worker): Promise<number | null> {
  return await worker.evaluate(async () => {
    const chromeApi = (globalThis as unknown as { readonly chrome: ExtensionChromeApi }).chrome;
    return (await chromeApi.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
  });
}

async function disconnectNativePort(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const port = Reflect.get(globalThis, "__nodexDisposableNativePort") as
      | NativePortLike
      | undefined;
    port?.disconnect();
    Reflect.deleteProperty(globalThis, "__nodexDisposableNativePort");
  });
}

let requestId = 1;

async function requestAttestedSocket(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  authorizer: ReturnType<typeof createBrowserUsePeerAuthorizer>,
  expectedIdentity: ChromeNativeHostPeerIdentity,
): Promise<unknown> {
  const id = requestId;
  requestId += 1;
  const socket = net.createConnection(socketPath);
  const decoder = new BrowserUseNativePipeFrameDecoder();
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.removeAllListeners();
        if (error) reject(error);
        else resolve(result);
      };
      const timeout = setTimeout(
        () => finish(new Error(`${method} timed out`)),
        REQUEST_TIMEOUT_MS,
      );
      socket.once("connect", () => {
        const authorization = authorizer(socket);
        if (
          authorization.teamId !== expectedIdentity.teamId ||
          authorization.signingIdentifier !== expectedIdentity.signingIdentifier
        ) {
          finish(new Error("Socket peer did not match the attested native host"));
          return;
        }
        socket.write(
          encodeBrowserUseNativePipeFrame(JSON.stringify({ id, jsonrpc: "2.0", method, params })),
        );
      });
      socket.on("data", (chunk) => {
        try {
          for (const message of decoder.push(chunk)) {
            const response: unknown = JSON.parse(message);
            if (!isRecord(response) || response.id !== id) continue;
            if (response.error !== undefined) finish(new Error(`${method} failed`));
            else finish(null, response.result);
          }
        } catch (error) {
          finish(error);
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error(`${method} socket closed`)));
    });
  } finally {
    socket.destroy();
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
  const directoryHandle = await fs.open(directory, fsConstants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function removeDisposableSocket(socketName: string): Promise<void> {
  if (!socketName || path.basename(socketName) !== socketName || socketName.includes("\0")) return;
  const socketPath = path.join(SOCKET_DIRECTORY, socketName);
  let stats;
  try {
    stats = await fs.lstat(socketPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  const currentUserId = process.getuid?.();
  if (
    !stats.isSocket() ||
    stats.isSymbolicLink() ||
    (currentUserId !== undefined && stats.uid !== currentUserId)
  ) {
    throw new Error("Disposable run socket failed cleanup identity checks");
  }
  await fs.unlink(socketPath);
}

function assertHandshake(
  handshake: ExtensionHandshake,
  extensionId: string,
  runtimeVersion: string,
): void {
  if (
    handshake.runtimeId !== extensionId ||
    handshake.hello.manifestSchemaVersion !== 2 ||
    handshake.hello.nativeHostProtocolVersion !== 2 ||
    !handshake.hello.supportedProtocolVersions.includes(2) ||
    !handshake.ensure.hasLocalAppServerUrl ||
    handshake.ensure.selected.appServerProtocolVersion !== 2 ||
    handshake.ensure.selected.nativeHostProtocolVersion !== 2 ||
    handshake.ensure.selected.appVersion !== runtimeVersion ||
    handshake.ensure.selected.cliVersion !== runtimeVersion ||
    handshake.ensure.selected.nativeHostVersion !== runtimeVersion
  ) {
    throw new Error("Native host handshake did not select the attested v2 runtime");
  }
}

async function runSignedGate(config: ChromeControlDisposableE2EConfig): Promise<unknown> {
  const selection = await loadRuntimeSelection(config.runtimeRoot);
  const chromeCapability = selection.manifest.capabilities.browserUse.backends.chrome;
  if (chromeCapability.status !== "available") throw new Error("Chrome capability is unavailable");
  const browserVersion = await requireChromeForTesting(config.browserExecutable);
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-chrome-control-e2e-"));
  const disposableRoot = await fs.realpath(createdRoot);
  const profile = path.join(disposableRoot, "cft-profile");
  const extensionRoot = path.join(disposableRoot, "extension");
  const temporaryDirectory = path.join(disposableRoot, "tmp");
  const isolatedHome = path.join(disposableRoot, "home");
  const codexHome = path.join(disposableRoot, "codex-home");
  let context: BrowserContext | null = null;
  let createdSocketNames: readonly string[] = [];
  let selectedRegistry: ChromeExtensionPipeRegistry | null = null;
  try {
    await Promise.all([
      fs.mkdir(profile, { mode: 0o700 }),
      fs.mkdir(temporaryDirectory, { mode: 0o700 }),
    ]);
    Object.assign(process.env, {
      CFFIXED_USER_HOME: isolatedHome,
      CODEX_HOME: codexHome,
      HOME: isolatedHome,
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      TMPDIR: temporaryDirectory,
    });
    const extension = await extractVerifiedExtension(
      config.extensionCrx,
      extensionRoot,
      selection.authority.extensionIds,
    );
    const nativeHostArtifact = findArtifact(selection.manifest, chromeCapability.nativeHost.path);
    const install = await installChromeNativeHost({
      authority: selection.authority,
      channel: "prod",
      expectedNativeHost: {
        sha256: nativeHostArtifact.sha256,
        signingTeamId: chromeCapability.nativeHost.signingTeamId,
        size: nativeHostArtifact.size,
      },
      homeDirectory: isolatedHome,
      runtimePaths: {
        browserClientPath: selection.paths.browserClient,
        browserServicePath: selection.paths.browserService,
        codexCliPath: selection.paths.codexCli,
        nativeHostPath: selection.paths.nativeHost,
        nodeModuleDirs: selection.paths.nodeModuleDirs,
        nodePath: selection.paths.node,
        nodeReplPath: selection.paths.nodeRepl,
        resourcesPath: selection.root,
      },
      runtimeStateHome: codexHome,
      runtimeVersion: chromeCapability.plugin.version,
      verifyNativeHost: async (nativeHostPath) => readChromeNativeHostIdentity(nativeHostPath),
    });
    const runnerIdentity = readChromeNativeHostIdentity(selection.paths.node);
    const peerAddonIdentity = readChromeNativeHostIdentity(selection.paths.peerAuthorization);
    if (
      runnerIdentity.teamId !== chromeCapability.nativeHost.signingTeamId ||
      peerAddonIdentity.teamId !== selection.manifest.peerAuthorization.signingTeamId
    ) {
      throw new Error("Signed runner or peer verifier does not match its attested team");
    }

    const wrapperPath = path.join(disposableRoot, "native-host-wrapper");
    await fs.writeFile(
      wrapperPath,
      [
        "#!/bin/sh",
        `export HOME=${shellQuote(isolatedHome)}`,
        `export CFFIXED_USER_HOME=${shellQuote(isolatedHome)}`,
        `export CODEX_HOME=${shellQuote(codexHome)}`,
        `export TMPDIR=${shellQuote(temporaryDirectory)}`,
        `export TMP=${shellQuote(temporaryDirectory)}`,
        `export TEMP=${shellQuote(temporaryDirectory)}`,
        "export BROWSER_USE_DISABLE_ROLLOUT_TRACKING=1",
        `exec ${shellQuote(install.nativeHostPath)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const profileManifestDirectory = path.join(profile, "NativeMessagingHosts");
    await fs.mkdir(profileManifestDirectory, { mode: 0o700 });
    await fs.writeFile(
      path.join(profileManifestDirectory, `${selection.authority.hostName}.json`),
      `${JSON.stringify(
        {
          allowed_origins: [`chrome-extension://${extension.extensionId}/`],
          description: "Disposable Nodex Chrome control evidence host",
          name: selection.authority.hostName,
          path: wrapperPath,
          type: "stdio",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const beforeSockets = new Set(await listSocketNamesIfSafe());
    context = await chromium.launchPersistentContext(profile, {
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      env: {
        ...process.env,
        CFFIXED_USER_HOME: isolatedHome,
        CODEX_HOME: codexHome,
        HOME: isolatedHome,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      },
      executablePath: config.browserExecutable,
      headless: false,
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    const worker = await waitForExtensionWorker(context, extension.extensionId);
    // tsx preserves function names through this helper; install it only in the disposable worker.
    await worker.evaluate("globalThis.__name = (target) => target");
    const handshake = await performExtensionHandshake(worker, {
      extensionId: extension.extensionId,
      extensionVersion: extension.extensionVersion,
      hostName: selection.authority.hostName,
    });
    assertHandshake(handshake, extension.extensionId, chromeCapability.plugin.version);
    const newSocketNames = await waitForNewSocketNames(beforeSockets);
    createdSocketNames = newSocketNames;
    const expectedPeerIdentity = install.peerIdentity;
    const rawAuthorizer = createBrowserUsePeerAuthorizer({
      addonPath: selection.paths.peerAuthorization,
      mode: "development",
      platform: "darwin",
    });
    const authorizationEvidence: Array<{
      readonly authorized: boolean;
      readonly reason?: string;
      readonly signingIdentifier?: string;
      readonly teamId?: string;
    }> = [];
    let registries: Array<{
      readonly name: string;
      readonly registry: ChromeExtensionPipeRegistry;
      readonly snapshot: ChromeExtensionPipeRegistrySnapshot;
    }> = await Promise.all(
      newSocketNames.map(async (name) => {
        const registry = new ChromeExtensionPipeRegistry({
          authority: selection.authority,
          candidateSocketNames: [name],
          directory: SOCKET_DIRECTORY,
          expectedPeerIdentity,
          healthCheckIntervalMs: 60_000,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          socketPeerAuthorizer: (socket) => {
            const result = rawAuthorizer(socket);
            if (authorizationEvidence.length < 16) authorizationEvidence.push(result);
            return result;
          },
        });
        const snapshot = await registry.start();
        return { name, registry, snapshot };
      }),
    );
    const readinessDeadline = Date.now() + 12_000;
    let ready = registries.filter(({ snapshot }) => snapshot.providerReady);
    while (ready.length === 0 && Date.now() < readinessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      registries = await Promise.all(
        registries.map(async ({ name, registry }) => ({
          name,
          registry,
          snapshot: await registry.refresh(),
        })),
      );
      ready = registries.filter(({ snapshot }) => snapshot.providerReady);
    }
    if (ready.length !== 1 || !ready[0]?.snapshot.instances[0]) {
      const blockedEvidence = {
        browser: {
          extensionCrxSha256: extension.crxSha256,
          extensionId: extension.extensionId,
          extensionVersion: extension.extensionVersion,
          product: browserVersion,
        },
        classification: "new-attested-native-host-sockets-unresponsive",
        handshake,
        isolation: {
          browserProfile: "fresh-mkdtemp",
          existingSocketConnections: 0,
          realUserProfileAccess: false,
        },
        provider: {
          candidateCount: registries.length,
          peerAuthorizations: authorizationEvidence,
          readyCount: ready.length,
        },
        runtime: {
          manifestSha256: selection.manifestSha256,
          nativeHostIdentity: install.peerIdentity,
          runnerIdentity,
          targetArch: selection.manifest.targetArch,
          version: chromeCapability.plugin.version,
        },
        schema: "nodex.chrome-control-disposable-e2e.v1",
        status: "blocked",
        verifiedAt: new Date().toISOString(),
      };
      await writeJsonAtomically(config.evidencePath, blockedEvidence);
      throw new Error(
        `Disposable run reached the native v2 handshake but no new socket became a responsive extension backend; evidence: ${config.evidencePath}`,
      );
    }
    for (const candidate of registries) {
      if (candidate !== ready[0]) candidate.registry.stop();
    }
    const selected = ready[0];
    selectedRegistry = selected.registry;
    const readySnapshot = selected.snapshot;
    const instance = readySnapshot.instances[0]!;
    if (instance.extensionId !== extension.extensionId || instance.family !== "chrome") {
      throw new Error("Provider readiness did not bind the exact Chrome extension identity");
    }
    const changedSnapshots: ChromeExtensionPipeRegistrySnapshot[] = [];
    const unsubscribe = selectedRegistry.subscribe((snapshot) => changedSnapshots.push(snapshot));

    const tabs = await createTabPair(worker);
    if (tabs.initialActiveTabId !== tabs.firstTabId) {
      throw new Error("Disposable focus fixture did not establish its initial active tab");
    }
    await requestAttestedSocket(
      path.join(SOCKET_DIRECTORY, selected.name),
      "getTabs",
      { session_id: "nodex-disposable-focus", turn_id: "nodex-disposable-focus-turn" },
      rawAuthorizer,
      expectedPeerIdentity,
    );
    let wrongInstanceRejected = false;
    try {
      await selectedRegistry.focusPresentation({
        extensionInstanceId: `${instance.extensionInstanceId}-wrong`,
        sessionId: "nodex-disposable-focus",
        tabId: String(tabs.secondTabId),
      });
    } catch {
      wrongInstanceRejected = true;
    }
    if (!wrongInstanceRejected) throw new Error("Focus admitted the wrong extension instance");
    await selectedRegistry.focusPresentation({
      extensionInstanceId: instance.extensionInstanceId,
      sessionId: "nodex-disposable-focus",
      tabId: String(tabs.secondTabId),
    });
    const activeTabId = await readActiveTabId(worker);
    if (activeTabId !== tabs.secondTabId) {
      throw new Error("Exact Chrome tab did not become active");
    }

    await disconnectNativePort(worker);
    await context.close();
    context = null;
    const disconnectDeadline = Date.now() + 8_000;
    let disconnectedSnapshot = selectedRegistry.snapshot();
    while (disconnectedSnapshot.providerReady && Date.now() < disconnectDeadline) {
      disconnectedSnapshot = await selectedRegistry.refresh();
      if (disconnectedSnapshot.providerReady) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    unsubscribe();
    if (
      disconnectedSnapshot.providerReady ||
      disconnectedSnapshot.revision <= readySnapshot.revision ||
      !changedSnapshots.some((snapshot) => !snapshot.providerReady)
    ) {
      throw new Error("Provider disconnect did not emit a closed readiness transition");
    }
    const selectedSocketRemoved = await fs
      .lstat(path.join(SOCKET_DIRECTORY, selected.name))
      .then(() => false)
      .catch((error: unknown) => isRecord(error) && error.code === "ENOENT");

    const evidence = {
      browser: {
        extensionCrxSha256: extension.crxSha256,
        extensionId: extension.extensionId,
        extensionVersion: extension.extensionVersion,
        product: browserVersion,
      },
      disconnect: {
        disconnectedInstance: instance,
        providerReady: disconnectedSnapshot.providerReady,
        revision: disconnectedSnapshot.revision,
        selectedSocketRemoved,
      },
      focus: {
        activeTabId,
        fromTabId: tabs.firstTabId,
        toTabId: tabs.secondTabId,
        wrongInstanceRejected,
      },
      handshake,
      isolation: {
        browserProfile: "fresh-mkdtemp",
        existingSocketConnections: 0,
        realUserProfileAccess: false,
      },
      provider: {
        instance,
        peerAuthorizations: authorizationEvidence,
        ready: readySnapshot.providerReady,
        revision: readySnapshot.revision,
      },
      runtime: {
        criticalArtifacts: selection.criticalArtifacts.map(
          ({ path: artifactPath, sha256, size }) => ({
            path: artifactPath,
            sha256,
            size,
          }),
        ),
        manifestSha256: selection.manifestSha256,
        nativeHostIdentity: install.peerIdentity,
        runnerIdentity,
        targetArch: selection.manifest.targetArch,
        version: chromeCapability.plugin.version,
      },
      schema: "nodex.chrome-control-disposable-e2e.v1",
      status: "passed",
      verifiedAt: new Date().toISOString(),
    };
    await writeJsonAtomically(config.evidencePath, evidence);
    return evidence;
  } finally {
    selectedRegistry?.stop();
    await context?.close().catch(() => undefined);
    await Promise.all(createdSocketNames.map(removeDisposableSocket));
    await fs.rm(disposableRoot, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const gate = resolveChromeControlDisposableE2EGate(process.env);
  if (gate.status === "skipped") {
    process.stdout.write(`${JSON.stringify(gate)}\n`);
    return;
  }
  const selection = await loadRuntimeSelection(gate.config.runtimeRoot);
  const signedNode = selection.paths.node;
  if (process.env[REEXEC_ENV] !== "1" || (await fs.realpath(process.execPath)) !== signedNode) {
    const scriptPath = process.argv[1];
    if (!scriptPath) throw new Error("Disposable Chrome gate script path is unavailable");
    const result = spawnSync(signedNode, ["--import", "tsx", scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, [REEXEC_ENV]: "1" },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Signed runtime node exited via ${result.signal}`);
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    return;
  }
  const evidence = await runSignedGate(gate.config);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const scriptPath = process.argv[1];
if (scriptPath && pathToFileURL(path.resolve(scriptPath)).href === import.meta.url) {
  void main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Disposable Chrome control gate failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
