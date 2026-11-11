import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import {
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  BROWSER_RUNTIME_SCHEMA_VERSION,
  isSafeWindowsBrowserRuntimePath,
  parseBrowserRuntimeManifest,
  parseWindowsBrowserRuntimePackageIdentity,
  type BrowserRuntimeArtifact,
  type WindowsAuthenticodePublisherPolicy,
  type WindowsBrowserRuntimeArch,
  type WindowsBrowserRuntimeManifest,
} from "../src/shared/browser-runtime-metadata";
import { WINDOWS_PE_MACHINE } from "../src/shared/windows-pe-header.mjs";
import { replaceOwnedDirectory } from "./replace-owned-directory";
import { inspectWindowsPe, verifyWindowsArchitectureClosure } from "./windows-pe.mjs";

type Options = {
  packageRoot: string;
  outputPath: string;
  targetArch: WindowsBrowserRuntimeArch;
  codexCompatibilityVersion: string;
};

const RESOURCE_ROOT = "app/resources/";
const PLUGINS = "plugins/openai-bundled/plugins/";
const MODULES = "cua_node/bin/node_modules";
const CLI_FILES = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-service.exe",
  "codex-windows-sandbox-setup.exe",
];
const BLOCK_BYTES = 64 * 1024;

function normalizedPackagePath(raw: string): string {
  const segments = raw.split("/").map((part) => decodeURIComponent(part));
  if (
    segments.some((segment) => segment.includes("/") || !isSafeWindowsBrowserRuntimePath(segment))
  ) {
    throw new Error(`Unsafe Windows package path: ${raw}`);
  }
  return segments.join("/");
}

function packageFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const seen = new Set<string>();
  function scan(directory: string, parent: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rawPath = path.join(directory, entry.name);
      const name = normalizedPackagePath(entry.name);
      const relative = parent ? `${parent}/${name}` : name;
      const key = relative.toLowerCase();
      if (seen.has(key)) throw new Error(`Windows package path alias: ${relative}`);
      seen.add(key);
      const stats = fs.lstatSync(rawPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        scan(rawPath, relative);
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw new Error(`Unsupported Windows package entry: ${relative}`);
      }
      files.set(relative, rawPath);
    }
  }
  if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) {
    throw new Error("Windows package root must be a real directory without symlink ancestors");
  }
  scan(root, "");
  return files;
}

function parseXml(contents: string) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(contents)) throw new Error("Windows package XML contains a DTD");
  return new DOMParser({
    onError: (_level, message) => {
      throw new Error(message);
    },
  }).parseFromString(contents.replace(/^\uFEFF/u, ""), "application/xml");
}

type BlockMapFile = { size: number; hashes: string[] };

function packageBlockMap(contents: string) {
  const blockMap = parseXml(contents);
  if (
    blockMap.documentElement?.getAttribute("HashMethod") !==
    "http://www.w3.org/2001/04/xmlenc#sha256"
  ) {
    throw new Error("Unsupported Windows package BlockMap hash method");
  }
  const entries = new Map<string, BlockMapFile>();
  for (const file of Array.from(blockMap.getElementsByTagName("File"))) {
    // BlockMap names already use installed spelling.
    const name = (file.getAttribute("Name") ?? "").replaceAll("\\", "/");
    const size = Number(file.getAttribute("Size"));
    if (
      !isSafeWindowsBrowserRuntimePath(name) ||
      entries.has(name.toLowerCase()) ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error(`Invalid Windows BlockMap entry: ${name}`);
    }
    const hashes = Array.from(
      file.getElementsByTagName("Block"),
      (block) => block.getAttribute("Hash") ?? "",
    );
    entries.set(name.toLowerCase(), { size, hashes });
  }
  return entries;
}

function assertMappedBytes(relative: string, bytes: Buffer, entry: BlockMapFile | undefined) {
  if (
    !entry ||
    bytes.length !== entry.size ||
    entry.hashes.length !== Math.ceil(bytes.length / BLOCK_BYTES) ||
    entry.hashes.some(
      (hash, i) =>
        hash !==
        createHash("sha256")
          .update(bytes.subarray(i * BLOCK_BYTES, (i + 1) * BLOCK_BYTES))
          .digest("base64"),
    )
  ) {
    throw new Error(`Windows package file does not match BlockMap: ${relative}`);
  }
}

/** PKCS#7 signer extraction only. Windows verifies the image digest and signer chain. */
function inspectEmbeddedPublisher(certificate: Buffer): WindowsAuthenticodePublisherPolicy {
  const pem = execFileSync(
    "openssl",
    [
      "smime",
      "-verify",
      "-inform",
      "DER",
      "-noverify",
      "-nosigs",
      "-signer",
      "/dev/stdout",
      "-out",
      "/dev/null",
    ],
    { input: certificate, stdio: ["pipe", "pipe", "pipe"] },
  );
  const names = execFileSync(
    "openssl",
    ["x509", "-noout", "-nameopt", "RFC2253", "-subject", "-issuer"],
    { input: pem, encoding: "utf8" },
  );
  const subject = /^subject=\s*(.+)$/mu.exec(names)?.[1]?.trim();
  const issuer = /^issuer=\s*(.+)$/mu.exec(names)?.[1]?.trim();
  if (
    !subject ||
    !issuer ||
    (pem.toString().match(/-----BEGIN CERTIFICATE-----/gu) ?? []).length !== 1
  ) {
    throw new Error("Could not identify the embedded Authenticode signer");
  }
  if (
    subject !== "CN=OpenAI OpCo\\, LLC,O=OpenAI OpCo\\, LLC,L=San Francisco,ST=California,C=US" ||
    !/^CN=Microsoft ID Verified CS AOC CA \d+,O=Microsoft Corporation,C=US$/u.test(issuer)
  ) {
    throw new Error(`Unexpected Desktop Tool publisher: ${subject} / ${issuer}`);
  }
  return { subject, issuer };
}

function destinationFor(relative: string, arch: WindowsBrowserRuntimeArch): string | null {
  if (CLI_FILES.includes(relative)) return `codex-cli/bin/${relative}`;
  if (relative === "native/windows-account.node") return relative;
  if (relative === "cua_node/bin/node.exe" || relative === "cua_node/bin/node_repl.exe") {
    return relative.slice("cua_node/".length);
  }
  if (
    relative === "cua_node/manifest.json" ||
    relative === "cua_node/bin/LICENSE" ||
    relative.startsWith(`${MODULES}/`)
  ) {
    if (relative.includes("/prebuilds/") && !relative.includes(`/prebuilds/win32-${arch}/`))
      return null;
    return `runtime/${relative.slice("cua_node/".length)}`;
  }
  if (!relative.startsWith(PLUGINS)) return null;
  const pluginPath = relative.slice(PLUGINS.length);
  if (!/^(?:browser|chrome|computer-use)\//u.test(pluginPath)) return null;
  if (pluginPath.includes("/prebuilds/") && !pluginPath.includes(`/prebuilds/win32-${arch}/`))
    return null;
  if (
    pluginPath.startsWith("chrome/extension-host/") &&
    !pluginPath.startsWith(`chrome/extension-host/windows/${arch}/`)
  )
    return null;
  return `marketplace/plugins/${pluginPath}`;
}

export function vendorWindowsBrowserRuntime(options: Options): WindowsBrowserRuntimeManifest {
  if (process.platform !== "darwin") {
    throw new Error("Vendoring extracted Windows Desktop Tools requires macOS");
  }
  const packageRoot = path.resolve(options.packageRoot);
  const output = path.resolve(options.outputPath);
  const fromSource = path.relative(packageRoot, output);
  const toSource = path.relative(output, packageRoot);
  if (![fromSource, toSource].every((relative) => relative.startsWith(`..${path.sep}`))) {
    throw new Error("The Desktop Tool output and extracted package must be separate trees");
  }
  const files = packageFiles(packageRoot);
  const read = (relative: string) => {
    const file = files.get(relative);
    if (!file) throw new Error(`Windows package is missing ${relative}`);
    return fs.readFileSync(file);
  };
  const blocks = packageBlockMap(read("AppxBlockMap.xml").toString());
  const readMapped = (relative: string) => {
    const bytes = read(relative);
    assertMappedBytes(relative, bytes, blocks.get(relative.toLowerCase()));
    return bytes;
  };
  const identity = parseXml(readMapped("AppxManifest.xml").toString()).getElementsByTagName(
    "Identity",
  );
  const sourcePackage = parseWindowsBrowserRuntimePackageIdentity({
    name: identity[0]?.getAttribute("Name"),
    publisher: identity[0]?.getAttribute("Publisher"),
    version: identity[0]?.getAttribute("Version"),
  });
  if (
    identity.length !== 1 ||
    identity[0]?.getAttribute("ProcessorArchitecture") !== options.targetArch ||
    sourcePackage?.name !== "OpenAI.Codex" ||
    sourcePackage.publisher !== "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B"
  ) {
    throw new Error("Unexpected Windows Desktop Tool package identity or architecture");
  }
  const ini = readMapped(`${RESOURCE_ROOT}owl-app.ini`).toString();
  const desktopBuild = /^AppVersion=(\d+(?:\.\d+)+)\s*$/mu.exec(ini)?.[1];
  if (!desktopBuild) throw new Error("Windows package does not declare a desktop build");
  const cua = JSON.parse(readMapped(`${RESOURCE_ROOT}cua_node/manifest.json`).toString());
  const arch = options.targetArch;
  if (
    cua.target !== `windows-${arch}` ||
    cua.platform !== "windows" ||
    cua.arch !== arch ||
    cua.node_path !== "bin/node.exe" ||
    cua.node_repl_path !== "bin/node_repl.exe" ||
    cua.node_modules !== "bin/node_modules"
  ) {
    throw new Error("Unexpected Windows CUA Node layout");
  }
  const pluginVersion = (name: string): string =>
    JSON.parse(readMapped(`${RESOURCE_ROOT}${PLUGINS}${name}/.codex-plugin/plugin.json`).toString())
      .version;
  const descriptor = JSON.parse(
    readMapped(`${RESOURCE_ROOT}${PLUGINS}chrome/scripts/extension-ids.json`).toString(),
  );
  const helper = arch === "arm64" ? "codex-computer-use-arm64.exe" : "codex-computer-use.exe";
  const moduleRoot = "runtime/bin/node_modules";
  const marketplaceManifest = "marketplace/.agents/plugins/marketplace.json";
  const browser = "marketplace/plugins/browser";
  const chrome = "marketplace/plugins/chrome";
  const computerUse = "marketplace/plugins/computer-use";
  const swift = `${moduleRoot}/@oai/sky/bin/windows/swift/${arch}`;
  const pe = new Map<string, WindowsBrowserRuntimeManifest["trust"]["pe"][string]>();
  const artifacts: BrowserRuntimeArtifact[] = [];

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const prepared = fs.mkdtempSync(path.join(path.dirname(output), ".browser-runtime-vendor-"));
  try {
    function write(relative: string, bytes: Buffer) {
      const destination = path.join(prepared, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: "wx" });
      const image = inspectWindowsPe(destination);
      const extension = path.extname(relative).toLowerCase();
      if (
        (image || [".exe", ".dll", ".node"].includes(extension)) &&
        (image?.machine !== WINDOWS_PE_MACHINE[arch] || !image.certificate)
      ) {
        throw new Error(`Wrong PE machine or missing embedded signature: ${relative}`);
      }
      if (image?.certificate) {
        pe.set(relative, { machine: arch, publisher: inspectEmbeddedPublisher(image.certificate) });
      }
      const kind = !image
        ? "data"
        : extension === ".dll"
          ? "library"
          : extension === ".node"
            ? "native-addon"
            : "executable";
      artifacts.push({
        architecture: image ? arch : "any",
        executable: kind === "executable",
        kind,
        path: relative,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    for (const relative of files.keys()) {
      const destination = relative.startsWith(RESOURCE_ROOT)
        ? destinationFor(relative.slice(RESOURCE_ROOT.length), arch)
        : null;
      if (destination) write(destination, readMapped(relative));
    }
    verifyWindowsArchitectureClosure(prepared, arch, { desktopToolsRoot: prepared });
    for (const name of [
      ...CLI_FILES.map((file) => `codex-cli/bin/${file}`),
      `${swift}/VCRUNTIME140.dll`,
      `${swift}/MSVCP140.dll`,
      ...(arch === "x64" ? [`${swift}/VCRUNTIME140_1.dll`] : []),
      `${moduleRoot}/@oai/cua/bin/windows/${helper}`,
    ]) {
      if (!pe.has(name)) throw new Error(`Desktop Tool dependency missing: ${name}`);
    }
    write(
      marketplaceManifest,
      Buffer.from(
        JSON.stringify(
          {
            name: "openai-bundled",
            plugins: ["browser", "chrome", "computer-use"].map((name) => ({
              name,
              source: { source: "local", path: `./plugins/${name}` },
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            })),
          },
          null,
          2,
        ) + "\n",
      ),
    );
    artifacts.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = parseBrowserRuntimeManifest({
      artifacts,
      browserPlugin: {
        id: "browser@openai-bundled",
        root: browser,
        version: pluginVersion("browser"),
        manifest: `${browser}/.codex-plugin/plugin.json`,
        marketplaceManifest,
        marketplaceRoot: "marketplace",
        client: `${browser}/scripts/browser-client.mjs`,
        service: `${browser}/scripts/browser-service.mjs`,
        docs: `${browser}/skills/control-in-app-browser/SKILL.md`,
        nodeModuleDirs: [moduleRoot, `${browser}/node_modules`],
      },
      buildFlavor: "production",
      capabilities: {
        browserUse: {
          backends: {
            iab: { status: "available" },
            chrome: {
              status: "available",
              extensionIds: descriptor.extensionIds,
              familyDescriptor: `${chrome}/scripts/extension-ids.json`,
              installManifest: `${chrome}/scripts/installManifest.mjs`,
              nativeHost: {
                path: `${chrome}/extension-host/windows/${arch}/extension-host.exe`,
                hostName: descriptor.extensionHostName,
              },
              plugin: {
                id: "chrome@openai-bundled",
                root: chrome,
                version: pluginVersion("chrome"),
                manifest: `${chrome}/.codex-plugin/plugin.json`,
              },
            },
          },
        },
        computerUse: {
          status: "available",
          serviceExecutable: `${moduleRoot}/@oai/sky/bin/windows/${helper}`,
          captureExecutable: `${swift}/codex-computer-use-swift.exe`,
          plugin: {
            id: "computer-use@openai-bundled",
            root: computerUse,
            version: pluginVersion("computer-use"),
            marketplaceManifest,
            marketplaceRoot: "marketplace",
            manifest: `${computerUse}/.codex-plugin/plugin.json`,
            docs: `${computerUse}/skills/computer-use/SKILL.md`,
            nodeModuleDirs: [moduleRoot],
          },
        },
      },
      codexCompatibilityVersion: options.codexCompatibilityVersion,
      desktopBuild,
      desktopBuildNumber: sourcePackage.version,
      entrypoints: {
        codexCli: "codex-cli/bin/codex.exe",
        node: "bin/node.exe",
        nodeRepl: "bin/node_repl.exe",
        processEnumeration: "native/windows-account.node",
      },
      runtimeVersions: {
        codexCli: options.codexCompatibilityVersion,
        cuaRuntime: cua.runtime_archive_version,
        node: cua.node_binary_version,
      },
      schemaVersion: BROWSER_RUNTIME_SCHEMA_VERSION,
      sourcePackage,
      supportedBackends: ["iab", "chrome"],
      targetArch: arch,
      targetPlatform: "win32",
      trust: { pe: Object.fromEntries([...pe].sort(([a], [b]) => a.localeCompare(b))) },
    });
    if (manifest?.targetPlatform !== "win32")
      throw new Error("Invalid vendored Windows Desktop Tool manifest");
    fs.writeFileSync(
      path.join(prepared, BROWSER_RUNTIME_MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    replaceOwnedDirectory(prepared, output);
    return manifest;
  } finally {
    fs.rmSync(prepared, { recursive: true, force: true });
  }
}
