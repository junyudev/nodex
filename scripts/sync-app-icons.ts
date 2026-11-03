import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncWindowsTrayIcons } from "./sync-windows-tray-icons";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const resourcesDir = join(projectRoot, "resources");
const sourceSvgPath = join(resourcesDir, "nodex-icon.svg");
const iconComposerDir = join(resourcesDir, "icon.icon");
const generatedIconPngPath = join(resourcesDir, "icon.png");
const generatedHighResPngPath = join(resourcesDir, "nodex-icon_3200x3200.png");
const generatedIcnsPath = join(resourcesDir, "icon.icns");
const requiredDerivedPaths = [generatedIconPngPath, generatedHighResPngPath, generatedIcnsPath];

function runCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function ensureDerivedArtifactsExist(): void {
  const missingArtifacts = requiredDerivedPaths.filter((targetPath) => !existsSync(targetPath));
  if (missingArtifacts.length === 0) {
    return;
  }

  throw new Error(
    [
      "Apple icon build tools are unavailable, and generated icon artifacts are missing.",
      ...missingArtifacts.map((missingPath) => `Missing: ${missingPath}`),
    ].join("\n"),
  );
}

function ensureSourceArtifactsExist(): void {
  const missingSources = [sourceSvgPath, iconComposerDir].filter(
    (targetPath) => !existsSync(targetPath),
  );
  if (missingSources.length === 0) {
    return;
  }

  throw new Error(
    [
      "Icon source artifacts are missing.",
      ...missingSources.map((missingPath) => `Missing: ${missingPath}`),
    ].join("\n"),
  );
}

function rasterizeSvgToPng(svgPath: string, outputPath: string, size: string): void {
  runCommand("sips", [
    "-s",
    "format",
    "png",
    svgPath,
    "--resampleHeightWidth",
    size,
    size,
    "--out",
    outputPath,
  ]);
}

function createIcnsFromPng(sourcePngPath: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "nodex-iconset-"));
  const iconsetDir = join(tempDir, "icon.iconset");
  const iconsetTargets = [
    { fileName: "icon_16x16.png", size: "16" },
    { fileName: "icon_16x16@2x.png", size: "32" },
    { fileName: "icon_32x32.png", size: "32" },
    { fileName: "icon_32x32@2x.png", size: "64" },
    { fileName: "icon_128x128.png", size: "128" },
    { fileName: "icon_128x128@2x.png", size: "256" },
    { fileName: "icon_256x256.png", size: "256" },
    { fileName: "icon_256x256@2x.png", size: "512" },
    { fileName: "icon_512x512.png", size: "512" },
    { fileName: "icon_512x512@2x.png", size: "1024" },
  ];

  mkdirSync(iconsetDir, {
    recursive: true,
  });

  try {
    for (const target of iconsetTargets) {
      runCommand("sips", [
        "-z",
        target.size,
        target.size,
        sourcePngPath,
        "--out",
        join(iconsetDir, target.fileName),
      ]);
    }

    runCommand("iconutil", ["--convert", "icns", "--output", generatedIcnsPath, iconsetDir]);
  } finally {
    rmSync(tempDir, {
      recursive: true,
      force: true,
    });
  }
}

async function main(): Promise<void> {
  ensureSourceArtifactsExist();

  const canGenerateAppleArtifacts =
    process.platform === "darwin" && commandExists("sips") && commandExists("iconutil");

  if (!canGenerateAppleArtifacts) {
    ensureDerivedArtifactsExist();
    await createWindowsIcon();
    return;
  }

  rasterizeSvgToPng(sourceSvgPath, generatedIconPngPath, "2048");
  rasterizeSvgToPng(sourceSvgPath, generatedHighResPngPath, "3200");
  createIcnsFromPng(generatedIconPngPath);
  await createWindowsIcon();
}

/** Use the pinned packager's portable PNG-to-ICO conversion on every host. */
async function createWindowsIcon(): Promise<void> {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const library = dirname(builderRequire.resolve("app-builder-lib/package.json"));
  const { convertIcon } = builderRequire(join(library, "out/util/iconConverter.js")) as {
    convertIcon(options: {
      sources: string[];
      fallbackSources: string[];
      roots: string[];
      format: "ico";
      outDir: string;
    }): Promise<unknown>;
  };
  await convertIcon({
    sources: [generatedIconPngPath],
    fallbackSources: [],
    roots: [resourcesDir],
    format: "ico",
    outDir: resourcesDir,
  });
  await syncWindowsTrayIcons();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
