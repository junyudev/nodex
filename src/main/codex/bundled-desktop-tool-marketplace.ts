import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { BROWSER_CONNECTIONS_COMMAND } from "../browser-use/chrome/browser-connection-facts";
import type { BrowserRuntimeArtifact } from "../../shared/browser-runtime-metadata";
import type { VerifiedBrowserRuntimeBundle } from "./browser-runtime-bundle";

const SOURCE_MARKETPLACE_NAME = "openai-bundled";
const MATERIALIZATION_SCHEMA_VERSION = 6;
const MATERIALIZATION_KEY_FILENAME = ".materialization-key";
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
  browserPluginVersion: string;
  chromePluginRoot: string | null;
  computerUsePluginRoot: string | null;
  materializationKey: string;
  marketplaceName: string;
  rootPath: string;
};

/** Profile ownership remains distinct when multiple Nodex Profiles share one native home. */
export const nodexDesktopToolMarketplaceName = (
  runtimeStateHome: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const canonical =
    platform === "win32"
      ? path.win32.resolve(runtimeStateHome).toLowerCase()
      : path.resolve(runtimeStateHome);
  return `nodex-desktop-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
};

/** Known desktop peers from another host must not load beside this Profile's signed peers. */
export const isForeignDesktopToolPlugin = (pluginId: string, runtimeStateHome: string): boolean => {
  const match = /^(browser|chrome|computer-use)@(openai-bundled|nodex-desktop-[a-f0-9]{12})$/u.exec(
    pluginId,
  );
  return match !== null && match[2] !== nodexDesktopToolMarketplaceName(runtimeStateHome);
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
  if (record.name !== SOURCE_MARKETPLACE_NAME || !Array.isArray(record.plugins)) {
    throw new Error("Bundled marketplace manifest has an unexpected shape");
  }
  const plugins = record.plugins.map((plugin) => {
    const candidate = parseRecord(plugin, "Bundled marketplace plugin");
    if (typeof candidate.name !== "string") {
      throw new Error("Bundled marketplace plugin is missing its name");
    }
    return candidate as MarketplaceManifest["plugins"][number];
  });
  return { ...record, name: SOURCE_MARKETPLACE_NAME, plugins } as MarketplaceManifest;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function claudePluginManifest(pluginRoot: string) {
  const vendor = parseRecord(
    await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
    "Bundled plugin manifest",
  );
  if (typeof vendor.name !== "string" || typeof vendor.version !== "string") {
    throw new Error("Bundled plugin manifest is missing its name or version");
  }
  return {
    name: vendor.name,
    version: vendor.version,
    ...(typeof vendor.description === "string" ? { description: vendor.description } : {}),
  };
}

async function writeClaudePluginManifest(pluginRoot: string): Promise<void> {
  const manifest = await claudePluginManifest(pluginRoot);
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), manifest);
}

function materializedBrowserVersion(vendorVersion: string): string {
  // Codex installs by version. A revised local skill needs a fresh cache entry.
  const separator = vendorVersion.includes("+") ? "." : "+";
  return `${vendorVersion}${separator}nodex.${MATERIALIZATION_SCHEMA_VERSION}`;
}

function materializationKey(
  bundle: VerifiedBrowserRuntimeBundle,
  includeComputerUse: boolean,
): string {
  const computerUse = bundle.manifest.capabilities.computerUse;
  const chrome = bundle.manifest.capabilities.browserUse.backends.chrome;
  return JSON.stringify({
    browserPluginVersion: materializedBrowserVersion(bundle.manifest.browserPlugin.version),
    chromePluginClosure: chromePluginClosure(bundle),
    chromePluginVersion: chrome.status === "available" ? chrome.plugin.version : null,
    computerUsePluginVersion:
      includeComputerUse && computerUse.status === "available" ? computerUse.plugin.version : null,
    desktopBuild: bundle.manifest.desktopBuild,
    desktopBuildNumber: bundle.manifest.desktopBuildNumber,
    schemaVersion: MATERIALIZATION_SCHEMA_VERSION,
    targetArch: bundle.manifest.targetArch,
    targetPlatform: bundle.manifest.targetPlatform,
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
      (process.platform !== "win32" && artifact.executable && (stats.mode & 0o111) === 0)
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
    const pluginNames = [
      "browser",
      ...(chromeClosure.length > 0 ? ["chrome"] : []),
      ...(includeComputerUse ? ["computer-use"] : []),
    ];
    for (const name of pluginNames) {
      const pluginRoot = path.join(rootPath, "plugins", name);
      const actual = await readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
      if (JSON.stringify(actual) !== JSON.stringify(await claudePluginManifest(pluginRoot))) {
        return false;
      }
    }
    if (!includeComputerUse) return true;
    await fs.access(path.join(rootPath, "plugins", "computer-use", COMPUTER_USE_SKILL_TARGET));
    return true;
  } catch {
    return false;
  }
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

/** Node's Windows ESM loader expects file URLs for drive-letter paths. */
export function windowsBrowserSkillBootstrap(source: string): string {
  return source.replace(
    'const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs");',
    [
      "// Replace <plugin root> with the absolute plugin path using forward slashes.",
      'const { pathToFileURL } = await import("node:url");',
      'const { setupBrowserRuntime } = await import(pathToFileURL("<plugin root>/scripts/browser-client.mjs").href);',
    ].join("\n"),
  );
}

function nodexBrowserSkill(vendorSkill: string, platform: NodeJS.Platform): string {
  const source = vendorSkill
    .replace(
      "Control the in-app Browser for opening",
      "Control the in-app Browser and connected browser profiles for opening",
    )
    .replace(" It can have existing signed-in sessions.", "")
    .replace(/^- `chrome-troubleshooting`:.*\n/mu, "");
  const supported =
    platform === "darwin" ? "Chrome, Edge, Brave, Opera, Vivaldi, Dia, and Arc" : "Chrome and Edge";
  const selection = `## Browser selection

The in-app Browser keeps its own sign-ins. Your connected browser profiles carry your sign-ins. Nodex can connect to ${supported} through the ChatGPT extension.

An explicitly named browser or tab is a hard requirement. Follow the tab-mention instructions for a named tab. Use \`agent.browsers.get("iab")\` for the in-app Browser and \`agent.browsers.get("dot")\` for Dot. A Browser plugin mention names the in-app Browser unless it specifies a \`browserFamily\`. A Chrome plugin mention names Chrome.

After bootstrap, read the live connections for a named external browser, the system default, or account work.

\`\`\`js
const connections = await nodeRepl.rpc("browser", {
  method: "execute",
  params: { type: "${BROWSER_CONNECTIONS_COMMAND}", browser_id: "iab" },
});
const inventory = await agent.browsers.list();
nodeRepl.write({ connections, inventory });
\`\`\`

Join a connected browser's \`extensionInstanceId\` to \`inventory[].metadata.extensionInstanceId\` and use \`agent.browsers.get(match.id)\`. Use the family and app name in \`connections.connectedBrowsers\` to identify the app. This works for Dia and Arc, whose extension can report Chrome. Use the exact connected instance for all actions. Use the live connection and running status for diagnosis. Open or focus tabs through the connected instance.

- For a named external browser or the user's own browser explicitly requested without a name, honor that constraint. If the requested browser is unavailable, explain the connection status and how to fix it. If multiple profiles match and the account matters, ask which profile to use.
- For account work with no browser named, first prefer a connected profile with the site open. Use \`browser.user.openTabs()\` and match the site's origin. An open tab is a clue. Confirm access on the requested page. Next prefer a connected profile of the system default browser. If neither is available to this chat, use the in-app Browser. For other tasks, reuse a suitable binding or use \`getForUrl(url)\` or \`getDefault()\`.
- When falling back from the expected browser, say once which browser you selected, why, and what the user can do. If Dia's extension is disconnected and the in-app Browser shows GitHub's sign-in screen, say something like “Dia is your default browser, and its ChatGPT extension isn't connected to Nodex. I selected the in-app Browser, which is asking you to sign in to GitHub. Open Dia with the ChatGPT extension enabled to use your Dia session, or sign in here.” If the connection exists but is absent from this chat's inventory, tell the user to retry in a fresh chat. When the app identity is unknown, say so.
- If authentication stops a task in an explicitly chosen browser, ask the user to sign in there or choose another browser. Keep cookie, storage, history, and profile data out of browser selection. Use the requested site and its supported sign-in flow.

After selecting a browser, return its complete documentation with \`nodeRepl.write(await browser.documentation())\` before using it.

## After setup
If setup or selection fails, read \`await agent.documentation.get("bootstrap-troubleshooting")\`. For an external browser, use the live connection facts to distinguish an unsupported browser, blocked host setup, and a disconnected extension. If the browser is closed, ask the user to open it. Direct the user to Browser Settings for host setup or to the named browser to enable the ChatGPT extension.

`;
  const start = source.indexOf("## Browser selection");
  const afterSetup = source.indexOf("## After setup", start);
  const end = source.indexOf("\n## ", (afterSetup < 0 ? start : afterSetup) + 1);
  const materialized =
    start < 0
      ? `${source.trimEnd()}\n\n${selection}`
      : source.slice(0, start) + selection + (end < 0 ? "" : source.slice(end + 1));
  return platform === "win32" ? windowsBrowserSkillBootstrap(materialized) : materialized;
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
  const browserPluginVersion = materializedBrowserVersion(bundle.manifest.browserPlugin.version);
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
    const browserManifestPath = path.join(browserPluginTarget, ".codex-plugin", "plugin.json");
    const browserManifest = parseRecord(await readJson(browserManifestPath), "Browser plugin");
    await writeJson(browserManifestPath, { ...browserManifest, version: browserPluginVersion });
    const relativeDocs = path.relative(bundle.browserPluginRoot, bundle.paths.browserPluginDocs);
    const skillPath = path.join(browserPluginTarget, relativeDocs);
    const source = await fs.readFile(skillPath, "utf8");
    await fs.writeFile(
      skillPath,
      nodexBrowserSkill(source, bundle.manifest.targetPlatform),
      "utf8",
    );
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
    }

    for (const pluginRoot of [browserPluginTarget, chromePluginTarget, computerUsePluginTarget]) {
      if (pluginRoot) await writeClaudePluginManifest(pluginRoot);
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
      name: nodexDesktopToolMarketplaceName(options.runtimeStateHome),
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
    browserPluginVersion,
    chromePluginRoot: includeChrome ? path.join(targetPath, "plugins", "chrome") : null,
    computerUsePluginRoot: includeComputerUse
      ? path.join(targetPath, "plugins", "computer-use")
      : null,
    materializationKey: key,
    marketplaceName: nodexDesktopToolMarketplaceName(options.runtimeStateHome),
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
    nodexDesktopToolMarketplaceName(options.runtimeStateHome),
  );
  const includeComputerUse =
    options.includeComputerUse &&
    options.bundle.manifest.capabilities.computerUse.status === "available";
  const chromeClosure = chromePluginClosure(options.bundle);
  const key = materializationKey(options.bundle, includeComputerUse);
  if (await isCurrentMaterialization(targetPath, key, chromeClosure, includeComputerUse)) {
    return {
      browserPluginRoot: path.join(targetPath, "plugins", "browser"),
      browserPluginVersion: materializedBrowserVersion(
        options.bundle.manifest.browserPlugin.version,
      ),
      chromePluginRoot:
        chromeClosure.length > 0 ? path.join(targetPath, "plugins", "chrome") : null,
      computerUsePluginRoot: includeComputerUse
        ? path.join(targetPath, "plugins", "computer-use")
        : null,
      materializationKey: key,
      marketplaceName: nodexDesktopToolMarketplaceName(options.runtimeStateHome),
      rootPath: targetPath,
    };
  }
  return await materializeFresh(options, targetPath, key);
}
