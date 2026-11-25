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

export type MaterializedDesktopToolPlugin = {
  rootPath: string;
  version: string;
  revisedSkillPath?: string;
};

export type MaterializedDesktopToolMarketplace = {
  browser: MaterializedDesktopToolPlugin;
  chrome: MaterializedDesktopToolPlugin | null;
  computerUse: MaterializedDesktopToolPlugin | null;
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

type PluginSkill = {
  relativePath: string;
  revision?: { number: number; rewrite: (source: string) => string };
};

type PluginMaterialization = {
  name: string;
  plugin: MaterializedDesktopToolPlugin;
  sourceRoot: string;
  skill?: PluginSkill;
};

function planPlugin(
  rootPath: string,
  name: string,
  sourceRoot: string | null,
  vendorVersion: string,
  skill?: PluginSkill,
): PluginMaterialization {
  if (!sourceRoot) throw new Error(`Verified ${name} plugin path is unavailable`);
  const revision = skill?.revision;
  // Codex installs by version. Revise each plugin independently to refresh its cache entry.
  const separator = vendorVersion.includes("+") ? "." : "+";
  return {
    name,
    sourceRoot,
    skill,
    plugin: {
      rootPath: path.join(rootPath, "plugins", name),
      version: revision ? `${vendorVersion}${separator}nodex.${revision.number}` : vendorVersion,
      ...(skill && revision ? { revisedSkillPath: skill.relativePath } : {}),
    },
  };
}

function materializationKey(
  bundle: VerifiedBrowserRuntimeBundle,
  plugins: Pick<MaterializedDesktopToolMarketplace, "browser" | "chrome" | "computerUse">,
  chromeClosure: readonly MaterializedChromeArtifact[],
): string {
  return JSON.stringify({
    browserPluginVersion: plugins.browser.version,
    chromePluginClosure: chromeClosure,
    chromePluginVersion: plugins.chrome?.version ?? null,
    computerUsePluginVersion: plugins.computerUse?.version ?? null,
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
  plans: readonly PluginMaterialization[],
): Promise<boolean> {
  try {
    const storedKey = await fs.readFile(path.join(rootPath, MATERIALIZATION_KEY_FILENAME), "utf8");
    if (storedKey.trim() !== key) return false;
    await fs.access(path.join(rootPath, ".agents", "plugins", "marketplace.json"));
    if (chromeClosure.length > 0 && !(await isCurrentChromeClosure(rootPath, chromeClosure))) {
      return false;
    }
    for (const { plugin, skill } of plans) {
      const expected = await claudePluginManifest(plugin.rootPath);
      if (expected.version !== plugin.version) return false;
      const actual = await readJson(path.join(plugin.rootPath, ".claude-plugin", "plugin.json"));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
      if (skill) await fs.access(path.join(plugin.rootPath, skill.relativePath));
    }
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

function nodexComputerUseSkill(source: string): string {
  const guidance = `## Web pages and safe actions in Nodex

Use the Browser skill, not Computer Use, for work inside a web page in the in-app Browser or in Chrome, Edge, Brave, Opera, Vivaldi, Dia or Arc. The Browser skill reads and operates the page itself, so text cannot land in the wrong field and its element references stay tied to the page.

- If the browser the task needs isn't connected to Nodex, tell the user how to connect it (turn on the ChatGPT extension in that browser) rather than operating its pages through Computer Use. Use Computer Use on a web page only when the user asks for it, or for the browser's own windows, menus and dialogs.
- To open a URL in a particular browser, run \`open -a "<App name>" "<url>"\` in a terminal instead of typing into its address bar.

Element indexes, focus and screenshots can change between reading an app and acting on it:

- Read the app state again after a keyboard shortcut, a focus change, an opened menu or popup, or an error saying the user changed the app. Never reuse earlier element indexes.
- Before acting on an \`element_index\`, check that the element in the latest state still has the role and name you expect. If it doesn't, read the state again instead of acting.
- Before \`type_text\`, or \`press_key\` with printable keys, confirm in the latest state that the intended field has focus. Prefer \`set_value\` when the field is settable. If you can't confirm focus, stop rather than type.
- Never enter passwords, tokens or other secrets with Computer Use.
- A screenshot can lag behind the app, especially while the app is in the background. When the screenshot and the accessibility text disagree, treat the screenshot as possibly stale and say so before showing it to the user as evidence.
`;
  const policy = /^# Computer Use Confirmations Policy\r?$/mu.exec(source);
  if (!policy) return `${source.trimEnd()}\n\n${guidance}`;
  return `${source.slice(0, policy.index)}${guidance}\n${source.slice(policy.index)}`;
}

async function materializePlugin(
  { name, sourceRoot, plugin, skill }: PluginMaterialization,
  stagingPath: string,
): Promise<void> {
  const target = path.join(stagingPath, "plugins", name);
  await fs.cp(sourceRoot, target, { recursive: true });
  if (skill?.revision) {
    const manifestPath = path.join(target, ".codex-plugin", "plugin.json");
    const manifest = parseRecord(await readJson(manifestPath), "Bundled plugin manifest");
    await writeJson(manifestPath, { ...manifest, version: plugin.version });
    const skillPath = path.join(target, skill.relativePath);
    const source = await fs.readFile(skillPath, "utf8");
    await fs.writeFile(skillPath, skill.revision.rewrite(source), "utf8");
  }
  await writeClaudePluginManifest(target);
}

async function materializeFresh(
  bundle: VerifiedBrowserRuntimeBundle,
  marketplace: MaterializedDesktopToolMarketplace,
  plans: readonly PluginMaterialization[],
): Promise<void> {
  const { rootPath, marketplaceName, materializationKey: key } = marketplace;
  const stagingPath = `${rootPath}.staging-${randomUUID()}`;
  await fs.mkdir(path.dirname(rootPath), { recursive: true });
  try {
    await fs.mkdir(path.join(stagingPath, "plugins"), { recursive: true });
    for (const plan of plans) {
      await materializePlugin(plan, stagingPath);
    }

    const sourceManifestPath = path.join(
      bundle.browserPluginMarketplaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    const marketplaceManifest = parseMarketplaceManifest(await readJson(sourceManifestPath));
    const selectedPluginNames = new Set(plans.map(({ name }) => name));
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
      name: marketplaceName,
      plugins,
    });
    await fs.writeFile(path.join(stagingPath, MATERIALIZATION_KEY_FILENAME), `${key}\n`, "utf8");
    await replaceDirectoryAtomically(stagingPath, rootPath);
  } catch (error) {
    await fs.rm(stagingPath, { force: true, recursive: true });
    throw error;
  }
}

export async function materializeBundledDesktopToolMarketplace(
  options: MaterializeDesktopToolMarketplaceOptions,
): Promise<MaterializedDesktopToolMarketplace> {
  const { bundle } = options;
  const marketplaceName = nodexDesktopToolMarketplaceName(options.runtimeStateHome);
  const rootPath = path.join(
    path.resolve(options.runtimeStateHome),
    ".tmp",
    "bundled-marketplaces",
    marketplaceName,
  );
  const platform = bundle.manifest.targetPlatform;
  const browser = planPlugin(
    rootPath,
    "browser",
    bundle.browserPluginRoot,
    bundle.manifest.browserPlugin.version,
    {
      relativePath: path.relative(bundle.browserPluginRoot, bundle.paths.browserPluginDocs),
      revision: { number: 6, rewrite: (source) => nodexBrowserSkill(source, platform) },
    },
  );
  const chromeCapability = bundle.manifest.capabilities.browserUse.backends.chrome;
  const chrome =
    chromeCapability.status === "available"
      ? planPlugin(
          rootPath,
          "chrome",
          bundle.paths.chromePluginRoot,
          chromeCapability.plugin.version,
        )
      : null;
  const computerUseCapability = bundle.manifest.capabilities.computerUse;
  const computerUse =
    options.includeComputerUse && computerUseCapability.status === "available"
      ? planPlugin(
          rootPath,
          "computer-use",
          bundle.paths.computerUsePluginRoot,
          computerUseCapability.plugin.version,
          {
            relativePath: COMPUTER_USE_SKILL_TARGET,
            ...(platform === "darwin"
              ? { revision: { number: 1, rewrite: nodexComputerUseSkill } }
              : {}),
          },
        )
      : null;
  const plugins = {
    browser: browser.plugin,
    chrome: chrome?.plugin ?? null,
    computerUse: computerUse?.plugin ?? null,
  };
  const plans = [browser, chrome, computerUse].filter((plan) => plan !== null);
  const chromeClosure = chromePluginClosure(bundle);
  const key = materializationKey(bundle, plugins, chromeClosure);
  const marketplace = { ...plugins, materializationKey: key, marketplaceName, rootPath };
  if (!(await isCurrentMaterialization(rootPath, key, chromeClosure, plans))) {
    await materializeFresh(bundle, marketplace, plans);
  }
  return marketplace;
}
