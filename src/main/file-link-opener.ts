import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { opendir, stat, access } from "node:fs/promises";
import { promisify } from "node:util";
import {
  FILE_LINK_OPENER_OPTIONS,
  normalizeFileLinkOpenerId,
  type FileLinkOpenerId,
  type FileLinkTarget,
} from "../shared/file-link-openers";
import {
  buildTextMateUrl,
  formatOpenFileLocation,
  normalizeFileLinkPosition,
  resolveDirectoryOpenPath,
  type NormalizedFileLinkPosition,
} from "./file-link-launch-plan";

const APPLICATIONS_DIRECTORIES = ["/Applications", join(homedir(), "Applications")];

const DOCUMENT_LIKE_EXTENSIONS = new Set([
  ".pdf",
  ".ppt",
  ".pptx",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".key",
  ".mov",
  ".mp4",
  ".pages",
  ".numbers",
  ".html",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tiff",
  ".ico",
  ".webp",
]);

interface CursorCliPaths {
  electronBin: string;
  cliJs: string;
}

interface XcodePaths {
  appPath: string | null;
  xedPath: string | null;
}

type JetBrainsFileLinkOpenerId =
  | "androidStudio"
  | "intellij"
  | "goland"
  | "rustrover"
  | "pycharm"
  | "webstorm";

interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
}

const JETBRAINS_APP_CONFIG: Record<
  JetBrainsFileLinkOpenerId,
  {
    fixedPaths: string[];
    bundlePrefix: string;
    executableName: string;
  }
> = {
  androidStudio: {
    fixedPaths: ["/Applications/Android Studio.app/Contents/MacOS/studio"],
    bundlePrefix: "Android Studio",
    executableName: "studio",
  },
  intellij: {
    fixedPaths: ["/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"],
    bundlePrefix: "IntelliJ IDEA",
    executableName: "idea",
  },
  goland: {
    fixedPaths: ["/Applications/GoLand.app/Contents/MacOS/goland"],
    bundlePrefix: "GoLand",
    executableName: "goland",
  },
  rustrover: {
    fixedPaths: ["/Applications/RustRover.app/Contents/MacOS/rustrover"],
    bundlePrefix: "RustRover",
    executableName: "rustrover",
  },
  pycharm: {
    fixedPaths: ["/Applications/PyCharm.app/Contents/MacOS/pycharm"],
    bundlePrefix: "PyCharm",
    executableName: "pycharm",
  },
  webstorm: {
    fixedPaths: ["/Applications/WebStorm.app/Contents/MacOS/webstorm"],
    bundlePrefix: "WebStorm",
    executableName: "webstorm",
  },
};

function runSpawn(executable: string, args: string[], options?: SpawnOptions): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const child = spawn(executable, args, {
      stdio: "ignore",
      env: options?.env ?? process.env,
    });

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    child.once("error", () => settle(false));
    child.once("exit", (code) => settle(code === 0));
  });
}

function candidatePathsWithUserMirror(paths: string[]): string[] {
  const mirrored: string[] = [];

  for (const value of paths) {
    mirrored.push(value);
    if (!value.startsWith("/Applications/")) continue;

    const suffix = value.slice("/Applications/".length);
    mirrored.push(join(homedir(), "Applications", suffix));
  }

  return mirrored;
}

function firstExistingPath(paths: string[]): string | null {
  for (const candidate of candidatePathsWithUserMirror(paths)) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

async function findBundleByPrefix(prefix: string): Promise<string | null> {
  const normalizedPrefix = prefix.toLowerCase();
  for (const root of APPLICATIONS_DIRECTORIES) {
    const directory = await opendir(root).catch(() => null);
    if (!directory) continue;
    for await (const entry of directory) {
      const name = entry.name.toLowerCase();
      if (name.startsWith(normalizedPrefix) && name.endsWith(".app")) return join(root, entry.name);
    }
  }
  return null;
}

async function findExecutableInBundle(
  bundlePrefix: string,
  executableName: string,
): Promise<string | null> {
  const bundle = await findBundleByPrefix(bundlePrefix);
  if (!bundle) return null;
  const executablePath = join(bundle, "Contents", "MacOS", executableName);
  return await access(executablePath).then(
    () => executablePath,
    () => null,
  );
}

const execFileAsync = promisify(execFile);
async function readCommandOutput(command: string, args: string[]): Promise<string | null> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 64 * 1024,
  }).catch(() => null);
  return result?.stdout.trim() || null;
}
const runWhich = (command: string) => readCommandOutput("which", [command]);

/** One asynchronous walk discovers all Toolbox editors; symlink directories cannot create cycles. */
export async function discoverToolboxExecutables(
  root: string,
  executableNames: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const candidates = new Map<string, { path: string; mtime: number }>();
  const pending = [root];
  const inspectBundle = async (bundle: string) => {
    for (const name of executableNames) {
      const path = join(bundle, "Contents", "MacOS", name);
      const metadata = await stat(path).catch(() => null);
      if (!metadata?.isFile() || metadata.mtimeMs <= (candidates.get(name)?.mtime ?? -Infinity))
        continue;
      candidates.set(name, { path, mtime: metadata.mtimeMs });
    }
  };
  while (pending.length > 0) {
    const current = pending.pop()!;
    const directory = await opendir(current).catch(() => null);
    if (!directory) continue;
    for await (const entry of directory) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      if (entry.name.endsWith(".app")) await inspectBundle(path);
      else pending.push(path);
    }
  }
  return new Map([...candidates].map(([name, candidate]) => [name, candidate.path]));
}

const scanJetBrainsToolboxExecutables = () =>
  discoverToolboxExecutables(
    join(homedir(), "Library", "Application Support", "JetBrains", "Toolbox", "apps"),
    [...new Set(Object.values(JETBRAINS_APP_CONFIG).map((config) => config.executableName))],
  );

async function detectJetBrainsExecutable(
  fixedPaths: string[],
  bundlePrefix: string,
  executableName: string,
  readToolbox = scanJetBrainsToolboxExecutables,
): Promise<string | null> {
  return (
    firstExistingPath(fixedPaths) ??
    (await findExecutableInBundle(bundlePrefix, executableName)) ??
    (await readToolbox()).get(executableName) ??
    null
  );
}

async function openInJetBrainsApp(
  openerId: JetBrainsFileLinkOpenerId,
  targetPath: string,
  position: NormalizedFileLinkPosition | null,
): Promise<boolean> {
  const config = JETBRAINS_APP_CONFIG[openerId];
  const executable = await detectJetBrainsExecutable(
    config.fixedPaths,
    config.bundlePrefix,
    config.executableName,
  );
  if (!executable) return Promise.resolve(false);

  const args = position
    ? ["--line", String(position.line), "--column", String(position.column), targetPath]
    : [targetPath];
  return runSpawn(executable, args);
}

async function detectCursorCliPaths(): Promise<CursorCliPaths | null> {
  const bundle = await findBundleByPrefix("Cursor");
  if (!bundle) return null;

  const electronBin = join(bundle, "Contents", "MacOS", "Cursor");
  const cliJs = join(bundle, "Contents", "Resources", "app", "out", "cli.js");
  if (!existsSync(electronBin) || !existsSync(cliJs)) return null;

  return {
    electronBin,
    cliJs,
  };
}

async function detectXcodePaths(): Promise<XcodePaths | null> {
  const appPath = await findBundleByPrefix("Xcode");
  const developerDir = await readCommandOutput("xcode-select", ["-p"]);
  const xedPath = firstExistingPath([
    ...(developerDir ? [join(developerDir, "usr", "bin", "xed")] : []),
    ...(appPath ? [join(appPath, "Contents", "Developer", "usr", "bin", "xed")] : []),
  ]);
  return appPath || xedPath ? { appPath, xedPath } : null;
}

async function detectZedExecutable(): Promise<string | null> {
  return (
    (await runWhich("zed")) ??
    firstExistingPath([
      "/Applications/Zed.app/Contents/MacOS/zed",
      "/Applications/Zed Preview.app/Contents/MacOS/zed",
      "/Applications/Zed Nightly.app/Contents/MacOS/zed",
    ]) ??
    findExecutableInBundle("Zed", "zed")
  );
}

async function detectZedBundleFromExecutable(executablePath: string): Promise<string | null> {
  const marker = "/Contents/MacOS/";
  const index = executablePath.indexOf(marker);
  if (index > 0) {
    const bundlePath = executablePath.slice(0, index);
    if (bundlePath.endsWith(".app") && existsSync(bundlePath)) {
      return bundlePath;
    }
  }

  return findBundleByPrefix("Zed");
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isDocumentLike(path: string): boolean {
  if (!isRegularFile(path)) return false;
  return DOCUMENT_LIKE_EXTENSIONS.has(extname(path).toLowerCase());
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function resolveTerminalEditorCommand(): Promise<string | null> {
  const explicit = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (explicit) return explicit;

  for (const candidate of ["nvim", "vim", "nano", "less"]) {
    const resolvedCommand = await runWhich(candidate);
    if (resolvedCommand) return resolvedCommand;
  }

  return null;
}

async function buildEditorShellCommand(path: string): Promise<string | null> {
  if (!existsSync(path) || isDirectory(path)) return null;

  const editorCommand = await resolveTerminalEditorCommand();
  if (!editorCommand) return null;

  const parentDirectory = dirname(path);
  return `cd ${quoteForShell(parentDirectory)} && ${editorCommand} ${quoteForShell(path)}`;
}

async function openFileInTerminalLikeTarget(
  openerId: "terminal" | "iterm2" | "ghostty",
  path: string,
): Promise<boolean> {
  const shellCommand = await buildEditorShellCommand(path);
  if (!shellCommand) return false;

  if (openerId === "terminal") {
    return runSpawn("osascript", [
      "-e",
      `tell application "Terminal" to do script "${escapeForAppleScript(shellCommand)}"`,
    ]);
  }

  if (openerId === "iterm2") {
    return runSpawn("osascript", [
      "-e",
      'tell application "iTerm"',
      "-e",
      "create window with default profile",
      "-e",
      `tell current session of current window to write text "${escapeForAppleScript(shellCommand)}"`,
      "-e",
      "end tell",
    ]);
  }

  const loginShell = process.env.SHELL?.trim() || "/bin/zsh";
  return runSpawn("open", ["-na", "Ghostty.app", "--args", "-e", loginShell, "-lc", shellCommand]);
}

function buildCursorEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.VSCODE_NODE_OPTIONS = env.NODE_OPTIONS;
  env.VSCODE_NODE_REPL_EXTERNAL_MODULE = env.NODE_REPL_EXTERNAL_MODULE;
  delete env.NODE_OPTIONS;
  delete env.NODE_REPL_EXTERNAL_MODULE;
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

async function findNearestXcodeContainer(startPath: string): Promise<string | null> {
  let currentDirectory = dirname(resolve(startPath));
  while (true) {
    const directory = await opendir(currentDirectory).catch(() => null);
    if (!directory) return null;
    let project: string | null = null;
    let hasPackage = false;
    for await (const entry of directory) {
      if (entry.name.endsWith(".xcworkspace")) return join(currentDirectory, entry.name);
      if (entry.name.endsWith(".xcodeproj")) project ??= join(currentDirectory, entry.name);
      if (entry.name === "Package.swift") hasPackage = true;
    }
    if (project) return project;
    if (hasPackage) return currentDirectory;
    const parent = dirname(currentDirectory);
    if (parent === currentDirectory) return null;
    currentDirectory = parent;
  }
}

async function openInXcode(
  path: string,
  position: NormalizedFileLinkPosition | null,
): Promise<boolean> {
  const detectedPaths = await detectXcodePaths();
  if (!detectedPaths) return false;

  if (detectedPaths.xedPath) {
    const args: string[] = [];
    const containerPath = await findNearestXcodeContainer(path);
    if (containerPath) {
      args.push("--project", containerPath);
    }
    if (position) {
      args.push("--line", String(position.line));
    }
    args.push(path);

    const opened = await runSpawn(detectedPaths.xedPath, args);
    if (opened) return true;
  }

  if (detectedPaths.appPath) {
    return runSpawn("open", ["-a", detectedPaths.appPath, path]);
  }

  return false;
}

async function openInZed(
  path: string,
  position: NormalizedFileLinkPosition | null,
): Promise<boolean> {
  const detectedExecutable = await detectZedExecutable();
  if (!detectedExecutable) return false;

  const locationArg = formatOpenFileLocation(path, position);
  const bundlePath = await detectZedBundleFromExecutable(detectedExecutable);

  if (bundlePath) {
    const openedInApp = await runSpawn("open", ["-a", bundlePath, path]);
    if (!openedInApp) return false;

    if (!position) return true;

    const zedCli = await runWhich("zed");
    if (!zedCli) return true;

    await runSpawn(zedCli, [locationArg]);
    return true;
  }

  return runSpawn(detectedExecutable, [locationArg]);
}

async function openInTerminalDirectory(appName: string, path: string): Promise<boolean> {
  return runSpawn("open", ["-a", appName, resolveDirectoryOpenPath(path)]);
}

async function openInFileManager(path: string): Promise<boolean> {
  return runSpawn("open", ["-R", path]);
}

const AVAILABLE_FILE_LINK_OPENERS_CACHE_TTL_MS = 60_000;
let availableFileLinkOpenersCache: {
  readonly expiresAt: number;
  readonly openers: readonly FileLinkOpenerId[];
} | null = null;

let availableFileLinkOpenersPending: Promise<FileLinkOpenerId[]> | null = null;

/** Concurrent menus share discovery while asynchronous filesystem and process calls keep Main available. */
export async function listAvailableFileLinkOpeners(): Promise<FileLinkOpenerId[]> {
  if (availableFileLinkOpenersCache && availableFileLinkOpenersCache.expiresAt > Date.now())
    return [...availableFileLinkOpenersCache.openers];
  availableFileLinkOpenersPending ??= discoverAvailableFileLinkOpeners().finally(() => {
    availableFileLinkOpenersPending = null;
  });
  return [...(await availableFileLinkOpenersPending)];
}

async function discoverAvailableFileLinkOpeners(): Promise<FileLinkOpenerId[]> {
  if (process.platform !== "darwin") return [];
  if (availableFileLinkOpenersCache && availableFileLinkOpenersCache.expiresAt > Date.now()) {
    return [...availableFileLinkOpenersCache.openers];
  }

  let toolboxScan: ReturnType<typeof scanJetBrainsToolboxExecutables> | null = null;
  const readToolbox = () => (toolboxScan ??= scanJetBrainsToolboxExecutables());
  const isAvailable = async (openerId: FileLinkOpenerId): Promise<boolean> => {
    switch (openerId) {
      case "vscode":
        return Boolean(
          firstExistingPath([
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "/Applications/Code.app/Contents/Resources/app/bin/code",
          ]),
        );
      case "vscodeInsiders":
        return Boolean(
          firstExistingPath([
            "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
            "/Applications/Code - Insiders.app/Contents/Resources/app/bin/code",
          ]),
        );
      case "cursor":
        return (await detectCursorCliPaths()) !== null;
      case "bbedit":
        return (await findBundleByPrefix("BBEdit")) !== null;
      case "sublimeText":
        return Boolean(
          (await runWhich("subl")) ??
          firstExistingPath(["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"]),
        );
      case "windsurf":
        return Boolean(
          firstExistingPath(["/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"]),
        );
      case "antigravity":
        return Boolean(
          firstExistingPath([
            "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
          ]),
        );
      case "fileManager":
        return true;
      case "terminal":
        return existsSync("/System/Applications/Utilities/Terminal.app");
      case "iterm2":
        return Boolean(firstExistingPath(["/Applications/iTerm.app", "/Applications/iTerm2.app"]));
      case "ghostty":
        return Boolean(firstExistingPath(["/Applications/Ghostty.app"]));
      case "warp":
        return Boolean(firstExistingPath(["/Applications/Warp.app"]));
      case "xcode":
        return (await detectXcodePaths()) !== null;
      case "androidStudio":
      case "intellij":
      case "goland":
      case "rustrover":
      case "pycharm":
      case "webstorm": {
        const config = JETBRAINS_APP_CONFIG[openerId];
        return Boolean(
          await detectJetBrainsExecutable(
            config.fixedPaths,
            config.bundlePrefix,
            config.executableName,
            readToolbox,
          ),
        );
      }
      case "zed":
        return (await detectZedExecutable()) !== null;
      case "textmate":
        return (await findBundleByPrefix("TextMate")) !== null;
    }
  };

  const openers: FileLinkOpenerId[] = [];
  for (const option of FILE_LINK_OPENER_OPTIONS) {
    if (await isAvailable(option.id)) openers.push(option.id);
  }
  availableFileLinkOpenersCache = {
    expiresAt: Date.now() + AVAILABLE_FILE_LINK_OPENERS_CACHE_TTL_MS,
    openers,
  };
  return [...openers];
}

export async function openFileLinkTarget(
  target: FileLinkTarget,
  openerId: FileLinkOpenerId,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;

  const normalizedTarget = normalizeFileLinkOpenerId(openerId);
  const position = normalizeFileLinkPosition(target);
  const locationArg = formatOpenFileLocation(target.path, position);

  switch (normalizedTarget) {
    case "vscode": {
      const executable = firstExistingPath([
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        "/Applications/Code.app/Contents/Resources/app/bin/code",
      ]);
      if (!executable) return false;
      return runSpawn(executable, ["--goto", locationArg]);
    }

    case "vscodeInsiders": {
      const executable = firstExistingPath([
        "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
        "/Applications/Code - Insiders.app/Contents/Resources/app/bin/code",
      ]);
      if (!executable) return false;
      return runSpawn(executable, ["--goto", locationArg]);
    }

    case "cursor": {
      const cursorPaths = await detectCursorCliPaths();
      if (!cursorPaths) return false;
      return runSpawn(cursorPaths.electronBin, [cursorPaths.cliJs, "--goto", locationArg], {
        env: buildCursorEnv(),
      });
    }

    case "bbedit":
      if (
        !(await findBundleByPrefix("BBEdit")) &&
        !firstExistingPath(["/Applications/BBEdit.app"])
      ) {
        return false;
      }
      return runSpawn("open", ["-a", "BBEdit", target.path]);

    case "sublimeText": {
      const executable =
        (await runWhich("subl")) ??
        firstExistingPath(["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"]);
      if (!executable) return false;
      return runSpawn(executable, [locationArg]);
    }

    case "windsurf": {
      const executable = firstExistingPath([
        "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf",
      ]);
      if (!executable) return false;
      return runSpawn(executable, ["--goto", locationArg]);
    }

    case "antigravity": {
      const executable = firstExistingPath([
        "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
      ]);
      if (!executable) return false;
      return runSpawn(executable, ["--goto", locationArg]);
    }

    case "fileManager":
      return openInFileManager(target.path);

    case "terminal": {
      if (!existsSync("/System/Applications/Utilities/Terminal.app")) return false;
      const openedInEditor = await openFileInTerminalLikeTarget("terminal", target.path);
      if (openedInEditor) return true;
      return openInTerminalDirectory("Terminal", target.path);
    }

    case "iterm2": {
      if (!firstExistingPath(["/Applications/iTerm.app", "/Applications/iTerm2.app"])) {
        return false;
      }
      const openedInEditor = await openFileInTerminalLikeTarget("iterm2", target.path);
      if (openedInEditor) return true;
      return openInTerminalDirectory("iTerm", target.path);
    }

    case "ghostty": {
      if (!firstExistingPath(["/Applications/Ghostty.app"])) return false;
      const openedInEditor = await openFileInTerminalLikeTarget("ghostty", target.path);
      if (openedInEditor) return true;
      return openInTerminalDirectory("Ghostty", target.path);
    }

    case "warp":
      if (!firstExistingPath(["/Applications/Warp.app"])) return false;
      return openInTerminalDirectory("Warp", target.path);

    case "xcode":
      return openInXcode(target.path, position);

    case "androidStudio":
    case "intellij":
    case "goland":
    case "rustrover":
    case "pycharm":
    case "webstorm":
      return openInJetBrainsApp(openerId as JetBrainsFileLinkOpenerId, target.path, position);

    case "zed":
      return openInZed(target.path, position);

    case "textmate":
      if (
        !(await findBundleByPrefix("TextMate")) &&
        !firstExistingPath(["/Applications/TextMate.app"])
      ) {
        return false;
      }
      return runSpawn("open", [
        "-a",
        "TextMate",
        position ? buildTextMateUrl(target.path, position) : target.path,
      ]);
  }
}

export function shouldPreferFileManagerForTarget(
  path: string,
  openerId: FileLinkOpenerId,
  hasExplicitTarget: boolean,
  positionRequested: boolean,
): boolean {
  if (hasExplicitTarget) return false;
  if (positionRequested) return false;
  if (!isDocumentLike(path)) return false;

  const editorTargets = new Set<FileLinkOpenerId>([
    "vscode",
    "vscodeInsiders",
    "cursor",
    "bbedit",
    "sublimeText",
    "windsurf",
    "antigravity",
    "xcode",
    "androidStudio",
    "intellij",
    "goland",
    "rustrover",
    "pycharm",
    "webstorm",
    "zed",
    "textmate",
  ]);

  return editorTargets.has(openerId);
}
