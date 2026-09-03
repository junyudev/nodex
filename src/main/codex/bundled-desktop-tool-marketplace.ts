import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserRuntimeArtifact } from "../../shared/browser-runtime-metadata";
import type { VerifiedBrowserRuntimeBundle } from "./browser-runtime-bundle";

const MARKETPLACE_NAME = "openai-bundled";
const MATERIALIZATION_SCHEMA_VERSION = 2;
const MATERIALIZATION_KEY_FILENAME = ".materialization-key";
const COMPUTER_USE_VARIANT_SOURCE = path.join(".codex-plugin", "computer-use-node-repl.md");
const COMPUTER_USE_SKILL_TARGET = path.join("skills", "computer-use", "SKILL.md");

type MarketplaceManifest = {
  name: string;
  plugins: Array<{
    name: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type MaterializedDesktopToolMarketplace = {
  browserPluginRoot: string;
  chromePluginRoot: string | null;
  computerUsePluginRoot: string | null;
  materializationKey: string;
  rootPath: string;
};

type MaterializeDesktopToolMarketplaceOptions = {
  bundle: VerifiedBrowserRuntimeBundle;
  includeComputerUse: boolean;
  runtimeStateHome: string;
};

type MaterializedChromeArtifact = Pick<
  BrowserRuntimeArtifact,
  "executable" | "kind" | "sha256" | "size"
> & {
  relativePath: string;
};

function parseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseMarketplaceManifest(value: unknown): MarketplaceManifest {
  const record = parseRecord(value, "Bundled marketplace manifest");
  if (record.name !== MARKETPLACE_NAME || !Array.isArray(record.plugins)) {
    throw new Error("Bundled marketplace manifest has an unexpected shape");
  }
  const plugins = record.plugins.map((plugin) => {
    const candidate = parseRecord(plugin, "Bundled marketplace plugin");
    if (typeof candidate.name !== "string") {
      throw new Error("Bundled marketplace plugin is missing its name");
    }
    return candidate as MarketplaceManifest["plugins"][number];
  });
  return { ...record, name: MARKETPLACE_NAME, plugins } as MarketplaceManifest;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function materializationKey(
  bundle: VerifiedBrowserRuntimeBundle,
  includeComputerUse: boolean,
): string {
  const computerUse = bundle.manifest.capabilities.computerUse;
  const chrome = bundle.manifest.capabilities.browserUse.backends.chrome;
  return JSON.stringify({
    browserPluginVersion: bundle.manifest.browserPlugin.version,
    chromePluginClosure: chromePluginClosure(bundle),
    chromePluginVersion: chrome.status === "available" ? chrome.plugin.version : null,
    computerUsePluginVersion:
      includeComputerUse && computerUse.status === "available" ? computerUse.plugin.version : null,
    desktopBuild: bundle.manifest.desktopBuild,
    desktopBuildNumber: bundle.manifest.desktopBuildNumber,
    schemaVersion: MATERIALIZATION_SCHEMA_VERSION,
    targetArch: bundle.manifest.targetArch,
  });
}

function chromePluginClosure(bundle: VerifiedBrowserRuntimeBundle): MaterializedChromeArtifact[] {
  const chrome = bundle.manifest.capabilities.browserUse.backends.chrome;
  if (chrome.status === "unavailable") return [];
  const rootPrefix = `${chrome.plugin.root}/`;
  return bundle.manifest.artifacts
    .filter((artifact) => artifact.path.startsWith(rootPrefix))
    .map((artifact) => ({
      executable: artifact.executable,
      kind: artifact.kind,
      relativePath: artifact.path.slice(rootPrefix.length),
      sha256: artifact.sha256,
      size: artifact.size,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function isCurrentChromeClosure(
  rootPath: string,
  closure: readonly MaterializedChromeArtifact[],
): Promise<boolean> {
  for (const artifact of closure) {
    const artifactPath = path.join(rootPath, "plugins", "chrome", artifact.relativePath);
    let stats;
    try {
      stats = await fs.lstat(artifactPath);
    } catch {
      return false;
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size !== artifact.size ||
      (artifact.executable && (stats.mode & 0o111) === 0)
    ) {
      return false;
    }
    if ((await sha256(artifactPath)) !== artifact.sha256) return false;
  }
  return true;
}

async function isCurrentMaterialization(
  rootPath: string,
  key: string,
  chromeClosure: readonly MaterializedChromeArtifact[],
  includeComputerUse: boolean,
): Promise<boolean> {
  try {
    const storedKey = await fs.readFile(path.join(rootPath, MATERIALIZATION_KEY_FILENAME), "utf8");
    if (storedKey.trim() !== key) return false;
    await fs.access(path.join(rootPath, ".agents", "plugins", "marketplace.json"));
    await fs.access(path.join(rootPath, "plugins", "browser", ".codex-plugin", "plugin.json"));
    if (chromeClosure.length > 0 && !(await isCurrentChromeClosure(rootPath, chromeClosure))) {
      return false;
    }
    if (!includeComputerUse) return true;
    await fs.access(path.join(rootPath, "plugins", "computer-use", COMPUTER_USE_SKILL_TARGET));
    return true;
  } catch {
    return false;
  }
}

async function applyComputerUseNodeReplVariant(pluginRoot: string): Promise<void> {
  const variantSource = path.join(pluginRoot, COMPUTER_USE_VARIANT_SOURCE);
  const skillTarget = path.join(pluginRoot, COMPUTER_USE_SKILL_TARGET);
  await fs.mkdir(path.dirname(skillTarget), { recursive: true });
  await fs.copyFile(variantSource, skillTarget);

  const pluginManifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const pluginManifest = parseRecord(
    await readJson(pluginManifestPath),
    "Computer Use plugin manifest",
  );
  await writeJson(pluginManifestPath, {
    ...pluginManifest,
    bundledContentVariant: "node-repl",
  });
}

async function replaceDirectoryAtomically(stagingPath: string, targetPath: string): Promise<void> {
  const previousPath = `${targetPath}.previous-${randomUUID()}`;
  let movedPrevious = false;
  try {
    await fs.rename(targetPath, previousPath);
    movedPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await fs.rename(stagingPath, targetPath);
  } catch (error) {
    if (movedPrevious) await fs.rename(previousPath, targetPath);
    throw error;
  }
  if (movedPrevious) {
    await fs.rm(previousPath, { force: true, recursive: true });
  }
}

async function materializeFresh(
  options: MaterializeDesktopToolMarketplaceOptions,
  targetPath: string,
  key: string,
): Promise<MaterializedDesktopToolMarketplace> {
  const { bundle } = options;
  const computerUse = bundle.manifest.capabilities.computerUse;
  const chrome = bundle.manifest.capabilities.browserUse.backends.chrome;
  const includeComputerUse = options.includeComputerUse && computerUse.status === "available";
  const includeChrome = chrome.status === "available";
  const stagingPath = `${targetPath}.staging-${randomUUID()}`;
  const browserPluginTarget = path.join(stagingPath, "plugins", "browser");
  const chromePluginTarget = includeChrome ? path.join(stagingPath, "plugins", "chrome") : null;
  const computerUsePluginTarget = includeComputerUse
    ? path.join(stagingPath, "plugins", "computer-use")
    : null;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.mkdir(path.dirname(browserPluginTarget), { recursive: true });
    await fs.cp(bundle.browserPluginRoot, browserPluginTarget, {
      recursive: true,
    });
    if (chromePluginTarget) {
      if (!bundle.paths.chromePluginRoot) {
        throw new Error("Verified Chrome plugin path is unavailable");
      }
      await fs.cp(bundle.paths.chromePluginRoot, chromePluginTarget, {
        recursive: true,
      });
    }
    if (computerUsePluginTarget) {
      if (!bundle.paths.computerUsePluginRoot) {
        throw new Error("Verified Computer Use plugin path is unavailable");
      }
      await fs.cp(bundle.paths.computerUsePluginRoot, computerUsePluginTarget, {
        recursive: true,
      });
      await applyComputerUseNodeReplVariant(computerUsePluginTarget);
    }

    const sourceManifestPath = path.join(
      bundle.browserPluginMarketplaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    const marketplaceManifest = parseMarketplaceManifest(await readJson(sourceManifestPath));
    const selectedPluginNames = new Set([
      "browser",
      ...(includeChrome ? ["chrome"] : []),
      ...(includeComputerUse ? ["computer-use"] : []),
    ]);
    const plugins = marketplaceManifest.plugins.filter((plugin) =>
      selectedPluginNames.has(plugin.name),
    );
    if (plugins.length !== selectedPluginNames.size) {
      throw new Error("Bundled marketplace is missing a required desktop tool plugin");
    }
    await fs.mkdir(path.join(stagingPath, ".agents", "plugins"), {
      recursive: true,
    });
    await writeJson(path.join(stagingPath, ".agents", "plugins", "marketplace.json"), {
      ...marketplaceManifest,
      plugins,
    });
    await fs.writeFile(path.join(stagingPath, MATERIALIZATION_KEY_FILENAME), `${key}\n`, "utf8");
    await replaceDirectoryAtomically(stagingPath, targetPath);
  } catch (error) {
    await fs.rm(stagingPath, { force: true, recursive: true });
    throw error;
  }

  return {
    browserPluginRoot: path.join(targetPath, "plugins", "browser"),
    chromePluginRoot: includeChrome ? path.join(targetPath, "plugins", "chrome") : null,
    computerUsePluginRoot: includeComputerUse
      ? path.join(targetPath, "plugins", "computer-use")
      : null,
    materializationKey: key,
    rootPath: targetPath,
  };
}

export async function materializeBundledDesktopToolMarketplace(
  options: MaterializeDesktopToolMarketplaceOptions,
): Promise<MaterializedDesktopToolMarketplace> {
  const targetPath = path.join(
    path.resolve(options.runtimeStateHome),
    ".tmp",
    "bundled-marketplaces",
    MARKETPLACE_NAME,
  );
  const includeComputerUse =
    options.includeComputerUse &&
    options.bundle.manifest.capabilities.computerUse.status === "available";
  const chromeClosure = chromePluginClosure(options.bundle);
  const key = materializationKey(options.bundle, includeComputerUse);
  if (await isCurrentMaterialization(targetPath, key, chromeClosure, includeComputerUse)) {
    return {
      browserPluginRoot: path.join(targetPath, "plugins", "browser"),
      chromePluginRoot:
        chromeClosure.length > 0 ? path.join(targetPath, "plugins", "chrome") : null,
      computerUsePluginRoot: includeComputerUse
        ? path.join(targetPath, "plugins", "computer-use")
        : null,
      materializationKey: key,
      rootPath: targetPath,
    };
  }
  return await materializeFresh(options, targetPath, key);
}
