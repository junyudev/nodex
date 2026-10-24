import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, relative } from "node:path";
import { agentRuntimeNativeDigest } from "./agent-runtime-native-inventory.mjs";
import {
  assertBrowserRuntimeSourceClosure,
  readBrowserRuntimeSourceManifest,
} from "./stage-browser-runtime";

export const AGENT_RUNTIME_NODE_PTY_VERSION = "1.1.0";
export interface AgentRuntimeNode {
  readonly executable: string;
  readonly sha256: string;
  readonly version: string;
  readonly modules: string;
  readonly napi: string;
  readonly platform: string;
  readonly architecture: string;
}
export interface AgentRuntimeNative {
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly identity: string;
  readonly artifactDigest: string;
  readonly node: AgentRuntimeNode;
}
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Use the same staged Node and verified artifact inventory as the execution process. */
export function resolveAgentRuntimeNode(root: string): AgentRuntimeNode {
  const browserRoot = join(root, ".generated/codex-runtime/agent-runtime/browser-runtime");
  const manifest = readBrowserRuntimeSourceManifest(browserRoot);
  if (manifest.targetPlatform !== process.platform || manifest.targetArch !== process.arch) {
    throw new Error(
      `Agent Runtime native build requires a ${manifest.targetPlatform}-${manifest.targetArch} host`,
    );
  }
  assertBrowserRuntimeSourceClosure(browserRoot, manifest);
  const executable = join(browserRoot, ...manifest.entrypoints.node.split("/"));
  const identity = JSON.parse(
    execFileSync(
      executable,
      [
        "-p",
        "JSON.stringify({version:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,architecture:process.arch})",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    ),
  ) as Omit<AgentRuntimeNode, "executable" | "sha256">;
  if (
    identity.platform !== manifest.targetPlatform ||
    identity.architecture !== manifest.targetArch ||
    identity.version !== manifest.runtimeVersions.node.replace(/^v/u, "")
  ) {
    throw new Error("Staged Node identity does not match the verified runtime manifest");
  }
  return { ...identity, executable, sha256: sha256(readFileSync(executable)) };
}

const ignoredSourceDirectories = new Set(["build", "prebuilds", "node_modules", ".git"]);
const isSource = (root: string, file: string): boolean =>
  !relative(root, file)
    .split(/[\\/]/u)
    .some((part) => ignoredSourceDirectories.has(part));

/** Exclude Electron's generated binary without excluding the native source or helpers. */
function sourceDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (file: string): void => {
    if (!isSource(root, file)) return;
    const stats = lstatSync(file);
    hash.update(`${relative(root, file)}\0${stats.mode & 0o777}\0`);
    if (stats.isFile()) {
      hash.update(readFileSync(file));
      return;
    }
    if (!stats.isDirectory()) throw new Error(`Native build source is not a regular file: ${file}`);
    for (const name of readdirSync(file).sort()) visit(join(file, name));
  };
  visit(root);
  return hash.digest("hex");
}

function toolchainIdentity(): unknown {
  const version = (command: string, args: string[]) =>
    execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }).trim();
  return {
    compiler:
      process.platform === "win32"
        ? (process.env.VCToolsVersion ?? "default-msvc")
        : version(process.env.CXX ?? "c++", ["--version"]),
    python: version(
      process.env.NODE_GYP_FORCE_PYTHON ??
        process.env.PYTHON ??
        (process.platform === "win32" ? "python" : "python3"),
      ["--version"],
    ),
    environment: Object.fromEntries(
      [
        "CC",
        "CXX",
        "CFLAGS",
        "CXXFLAGS",
        "LDFLAGS",
        "SDKROOT",
        "MACOSX_DEPLOYMENT_TARGET",
        "GYP_MSVS_VERSION",
        "VCToolsInstallDir",
      ].map((name) => [name, process.env[name] ?? ""]),
    ),
  };
}

/** Package-manager Electron target flags must not override node-gyp's explicit Node target. */
export const agentRuntimeNativeBuildEnvironment = (
  node: AgentRuntimeNode,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !/^(?:npm_config_|npm_package_config_node_gyp_)/iu.test(name) &&
        !["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"].includes(name),
    ),
  ),
  PATH: `${dirname(node.executable)}${delimiter}${environment.PATH ?? ""}`,
});

/** Call under the Agent Runtime build lock; this never writes to installed dependencies. */
export function materializeAgentRuntimeNative(root: string): AgentRuntimeNative {
  const node = resolveAgentRuntimeNode(root);
  const require = createRequire(join(root, "package.json"));
  const packageRoot = dirname(require.resolve("node-pty/package.json"));
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  if (packageJson.version !== AGENT_RUNTIME_NODE_PTY_VERSION) {
    throw new Error(
      `Agent Runtime requires node-pty ${AGENT_RUNTIME_NODE_PTY_VERSION}; found ${packageJson.version}`,
    );
  }
  const addonRoot = dirname(
    createRequire(join(packageRoot, "package.json")).resolve("node-addon-api/package.json"),
  );
  const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
  const provenance = {
    recipe: sha256(readFileSync(new URL(import.meta.url))),
    inventoryRecipe: sha256(
      readFileSync(new URL("./agent-runtime-native-inventory.mjs", import.meta.url)),
    ),
    version: AGENT_RUNTIME_NODE_PTY_VERSION,
    source: sourceDigest(packageRoot),
    addonApi: sourceDigest(addonRoot),
    nodeGyp: sourceDigest(dirname(dirname(nodeGyp))),
    lock: sha256(readFileSync(join(root, "pnpm-lock.yaml"))),
    node,
    toolchain: toolchainIdentity(),
  };
  const identity = sha256(JSON.stringify(provenance));
  const target = join(
    root,
    ".generated/agent-runtime-native",
    `${node.platform}-${node.architecture}`,
  );
  const outputPackage = join(target, "node_modules/node-pty");
  const manifestPath = join(target, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      identity: string;
      artifactDigest: string;
    };
    if (
      manifest.identity === identity &&
      manifest.artifactDigest === agentRuntimeNativeDigest(outputPackage)
    ) {
      return {
        packageRoot: outputPackage,
        manifestPath,
        identity,
        artifactDigest: manifest.artifactDigest,
        node,
      };
    }
  } catch {
    /* An incomplete or damaged private build is replaced atomically. */
  }
  mkdirSync(dirname(target), { recursive: true });
  const temporary = mkdtempSync(join(dirname(target), ".build-"));
  const source = join(temporary, "source");
  const output = join(temporary, "output");
  const builtPackage = join(output, "node_modules/node-pty");
  const previous = join(temporary, "previous");
  try {
    cpSync(packageRoot, source, { recursive: true, filter: (file) => isSource(packageRoot, file) });
    cpSync(addonRoot, join(source, "node_modules/node-addon-api"), { recursive: true });
    execFileSync(
      node.executable,
      [
        nodeGyp,
        "rebuild",
        "--dist-url=https://nodejs.org/download/release",
        `--target=${node.version}`,
        `--arch=${node.architecture}`,
        `--devdir=${join(root, ".generated/agent-runtime-native/headers")}`,
      ],
      {
        cwd: source,
        stdio: "pipe",
        timeout: 180_000,
        env: agentRuntimeNativeBuildEnvironment(node, process.env),
      },
    );
    mkdirSync(builtPackage, { recursive: true });
    for (const name of ["package.json", "LICENSE", "lib", "third_party"]) {
      if (!existsSync(join(source, name))) continue;
      cpSync(join(source, name), join(builtPackage, name), {
        recursive: true,
        filter: (file) => !/\.(?:test\.js(?:\.map)?|map)$/u.test(file),
      });
    }
    const release = join(source, "build/Release");
    mkdirSync(join(builtPackage, "build/Release"), { recursive: true });
    for (const name of readdirSync(release)) {
      if (!/\.node$|\.dll$|\.exe$|^spawn-helper$/u.test(name)) continue;
      cpSync(join(release, name), join(builtPackage, "build/Release", name));
    }
    if (node.platform === "darwin")
      chmodSync(join(builtPackage, "build/Release/spawn-helper"), 0o755);
    execFileSync(node.executable, ["-e", "require(process.argv[1])", builtPackage], {
      timeout: 10_000,
    });
    const artifactDigest = agentRuntimeNativeDigest(builtPackage);
    writeFileSync(
      join(output, "manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, identity, artifactDigest, ...provenance }, null, 2)}\n`,
    );
    if (existsSync(target)) renameSync(target, previous);
    try {
      renameSync(output, target);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, target);
      throw error;
    }
    return { packageRoot: outputPackage, manifestPath, identity, artifactDigest, node };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
