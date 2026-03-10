import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  join,
  resolve,
} from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
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

const APPLICATIONS_DIRECTORIES = [
  "/Applications",
  join(homedir(), "Applications"),
];

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

const JETBRAINS_APP_CONFIG: Record<JetBrainsFileLinkOpenerId, {
  fixedPaths: string[];
  bundlePrefix: string;
  executableName: string;
}> = {
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

function runSpawn(
  executable: string,
  args: string[],
  options?: SpawnOptions,
): Promise<boolean> {
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

function findBundleByPrefix(prefix: string): string | null {
  const normalizedPrefix = prefix.toLowerCase();

  for (const root of APPLICATIONS_DIRECTORIES) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    const match = entries.find((entry) =>
      entry.toLowerCase().startsWith(normalizedPrefix)
      && entry.toLowerCase().endsWith(".app"));
    if (!match) continue;

    const bundlePath = join(root, match);
    if (existsSync(bundlePath)) return bundlePath;
  }

  return null;
}

function findExecutableInBundle(
  bundlePrefix: string,
  executableName: string,
): string | null {
  const bundle = findBundleByPrefix(bundlePrefix);
  if (!bundle) return null;

  const executablePath = join(bundle, "Contents", "MacOS", executableName);
  return existsSync(executablePath) ? executablePath : null;
}

function runWhich(command: string): string | null {
  const result = spawnSync("which", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;

  const output = result.stdout.trim();
  return output.length > 0 ? output : null;
}

function compareFileMtimeDesc(a: string, b: string): number {
  const aTime = statSync(a).mtimeMs;
  const bTime = statSync(b).mtimeMs;
  return bTime - aTime;
}

function scanJetBrainsToolboxExecutable(executableName: string): string | null {
  const toolboxRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "JetBrains",
    "Toolbox",
    "apps",
  );
  if (!existsSync(toolboxRoot)) return null;

  const candidates: string[] = [];

  function visit(currentPath: string): void {
    let entries: string[];
    try {
      entries = readdirSync(currentPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      const nextPath = join(currentPath, entry);
      let stats;
      try {
        stats = statSync(nextPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (entry.endsWith(".app")) {
          const executablePath = join(nextPath, "Contents", "MacOS", executableName);
          if (existsSync(executablePath)) {
            candidates.push(executablePath);
          }
          continue;
        }

        visit(nextPath);
      }
    }
  }

  visit(toolboxRoot);

  if (candidates.length === 0) return null;
  candidates.sort(compareFileMtimeDesc);
  return candidates[0];
}

function detectJetBrainsExecutable(
  fixedPaths: string[],
  bundlePrefix: string,
  executableName: string,
): string | null {
  return firstExistingPath(fixedPaths)
    ?? findExecutableInBundle(bundlePrefix, executableName)
    ?? scanJetBrainsToolboxExecutable(executableName);
}

function openInJetBrainsApp(
  openerId: JetBrainsFileLinkOpenerId,
  targetPath: string,
  position: NormalizedFileLinkPosition | null,
): Promise<boolean> {
  const config = JETBRAINS_APP_CONFIG[openerId];
  const executable = detectJetBrainsExecutable(
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

function detectCursorCliPaths(): CursorCliPaths | null {
  const bundle = findBundleByPrefix("Cursor");
  if (!bundle) return null;

  const electronBin = join(bundle, "Contents", "MacOS", "Cursor");
  const cliJs = join(bundle, "Contents", "Resources", "app", "out", "cli.js");
  if (!existsSync(electronBin) || !existsSync(cliJs)) return null;

  return {
    electronBin,
    cliJs,
  };
}

function detectXcodePaths(): XcodePaths | null {
  const appPath = findBundleByPrefix("Xcode");
  let xedPath: string | null = null;

  const developerDirResult = spawnSync("xcode-select", ["-p"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const developerDir = developerDirResult.status === 0
    ? developerDirResult.stdout.trim()
    : "";
  if (developerDir) {
    const candidate = join(developerDir, "usr", "bin", "xed");
    if (existsSync(candidate)) xedPath = candidate;
  }

  if (!xedPath && appPath) {
    const candidate = join(appPath, "Contents", "Developer", "usr", "bin", "xed");
    if (existsSync(candidate)) xedPath = candidate;
  }

  if (!appPath && !xedPath) return null;

  return {
    appPath,
    xedPath,
  };
}

function detectZedExecutable(): string | null {
  return runWhich("zed")
    ?? firstExistingPath([
      "/Applications/Zed.app/Contents/MacOS/zed",
      "/Applications/Zed Preview.app/Contents/MacOS/zed",
      "/Applications/Zed Nightly.app/Contents/MacOS/zed",
    ])
    ?? findExecutableInBundle("Zed", "zed");
}

function detectZedBundleFromExecutable(executablePath: string): string | null {
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
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function resolveTerminalEditorCommand(): string | null {
  const explicit = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (explicit) return explicit;

  for (const candidate of ["nvim", "vim", "nano", "less"]) {
    const resolvedCommand = runWhich(candidate);
    if (resolvedCommand) return resolvedCommand;
  }

  return null;
}

function buildEditorShellCommand(path: string): string | null {
  if (!existsSync(path) || isDirectory(path)) return null;

  const editorCommand = resolveTerminalEditorCommand();
  if (!editorCommand) return null;

  const parentDirectory = dirname(path);
  return `cd ${quoteForShell(parentDirectory)} && ${editorCommand} ${quoteForShell(path)}`;
}

async function openFileInTerminalLikeTarget(
  openerId: "terminal" | "iterm2" | "ghostty",
  path: string,
): Promise<boolean> {
  const shellCommand = buildEditorShellCommand(path);
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
  return runSpawn("open", [
    "-na",
    "Ghostty.app",
    "--args",
    "-e",
    loginShell,
    "-lc",
    shellCommand,
  ]);
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

function findNearestXcodeContainer(startPath: string): string | null {
  let currentDirectory = dirname(resolve(startPath));

  while (true) {
    let entries: string[];
    try {
      entries = readdirSync(currentDirectory);
    } catch {
      break;
    }

    const workspace = entries.find((entry) => entry.endsWith(".xcworkspace"));
    if (workspace) return join(currentDirectory, workspace);

    const project = entries.find((entry) => entry.endsWith(".xcodeproj"));
    if (project) return join(currentDirectory, project);

    if (entries.includes("Package.swift")) return currentDirectory;

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) break;
    currentDirectory = parentDirectory;
  }

  return null;
}

async function openInXcode(
  path: string,
  position: NormalizedFileLinkPosition | null,
): Promise<boolean> {
  const detectedPaths = detectXcodePaths();
  if (!detectedPaths) return false;

  if (detectedPaths.xedPath) {
    const args: string[] = [];
    const containerPath = findNearestXcodeContainer(path);
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
  const detectedExecutable = detectZedExecutable();
  if (!detectedExecutable) return false;

  const locationArg = formatOpenFileLocation(path, position);
  const bundlePath = detectZedBundleFromExecutable(detectedExecutable);

  if (bundlePath) {
    const openedInApp = await runSpawn("open", ["-a", bundlePath, path]);
    if (!openedInApp) return false;

    if (!position) return true;

    const zedCli = runWhich("zed");
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
      const cursorPaths = detectCursorCliPaths();
      if (!cursorPaths) return false;
      return runSpawn(
        cursorPaths.electronBin,
        [cursorPaths.cliJs, "--goto", locationArg],
        { env: buildCursorEnv() },
      );
    }

    case "bbedit":
      if (!findBundleByPrefix("BBEdit") && !firstExistingPath(["/Applications/BBEdit.app"])) {
        return false;
      }
      return runSpawn("open", ["-a", "BBEdit", target.path]);

    case "sublimeText": {
      const executable = runWhich("subl")
        ?? firstExistingPath([
          "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl",
        ]);
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
      if (
        !firstExistingPath([
          "/Applications/iTerm.app",
          "/Applications/iTerm2.app",
        ])
      ) {
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
      return openInJetBrainsApp(
        openerId as JetBrainsFileLinkOpenerId,
        target.path,
        position,
      );

    case "zed":
      return openInZed(target.path, position);

    case "textmate":
      if (!findBundleByPrefix("TextMate") && !firstExistingPath(["/Applications/TextMate.app"])) {
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
