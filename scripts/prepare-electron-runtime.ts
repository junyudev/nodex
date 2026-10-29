import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  cloneImmutableDirectory,
  ensureImmutableDirectory,
  immutableDirectoryDigest,
  resolveImmutableDirectoryPath,
} from "./immutable-artifact-cache";
import { replaceOwnedDirectory } from "./replace-owned-directory";

const RECEIPT_NAME = ".nodex-electron.json";
const RECIPE = "dist-v1";
const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const TRANSIENT_DOWNLOAD_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

interface ElectronArchive {
  readonly arch: string;
  readonly artifactName: "electron";
  readonly checksums: Readonly<Record<string, string>>;
  readonly platform: string;
  readonly version: string;
}

interface ElectronInstaller {
  readonly downloadArtifact: (input: ElectronArchive) => Promise<string>;
  readonly extract: (archivePath: string, options: { readonly dir: string }) => Promise<void>;
}

export interface PrepareElectronRuntimeOptions {
  /** The caller owns the project location, independently of this module's bundled location. */
  readonly projectRoot: string;
  /** Explicit family root, primarily for isolated verification. */
  readonly cachePath?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly installer?: ElectronInstaller;
}

function executableRelativePath(platform: string): string {
  if (platform === "darwin" || platform === "mas") return "Electron.app/Contents/MacOS/Electron";
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") return "electron";
  if (platform === "win32") return "electron.exe";
  throw new Error(`Electron builds are not available on platform: ${platform}`);
}

function assertDistribution(directory: string, version: string, executable: string): void {
  if (readFileSync(path.join(directory, "version"), "utf8").replace(/^v/u, "").trim() !== version) {
    throw new Error("Electron distribution version does not match the installed package.");
  }
  const metadata = lstatSync(path.join(directory, executable));
  if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o111) === 0)) {
    throw new Error("Electron distribution executable is missing or non-executable.");
  }
}

function validLocalDistribution(
  packageRoot: string,
  identity: string,
  version: string,
  executable: string,
): boolean {
  try {
    const receipt = JSON.parse(readFileSync(path.join(packageRoot, RECEIPT_NAME), "utf8")) as {
      readonly identity?: unknown;
      readonly digest?: unknown;
    };
    if (receipt.identity !== identity || typeof receipt.digest !== "string") return false;
    if (readFileSync(path.join(packageRoot, "path.txt"), "utf8") !== executable) return false;
    const distribution = path.join(packageRoot, "dist");
    assertDistribution(distribution, version, executable);
    return immutableDirectoryDigest(distribution) === receipt.digest;
  } catch {
    return false;
  }
}

function writeAtomic(filePath: string, contents: string): void {
  const temporary = `${filePath}.part-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isTransientDownloadError(error: unknown): boolean {
  const visited = new Set<Error>();
  for (let cause = error; cause instanceof Error && !visited.has(cause); cause = cause.cause) {
    visited.add(cause);
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      TRANSIENT_DOWNLOAD_CODES.has(cause.code)
    ) {
      return true;
    }
  }
  return false;
}

/** Only transport failures are retried; archive verification and extraction remain fail-fast. */
async function downloadElectronArchive(installer: ElectronInstaller, archive: ElectronArchive) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await installer.downloadArtifact(archive);
    } catch (error) {
      const delay = DOWNLOAD_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientDownloadError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Shares verified Electron extraction, while each installation owns independent writable files. */
export async function prepareElectronRuntime(
  options: PrepareElectronRuntimeOptions,
): Promise<string> {
  const projectRoot = path.resolve(options.projectRoot);
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const electronPackage = projectRequire.resolve("electron/package.json");
  const packageRoot = path.dirname(electronPackage);
  const electronRequire = createRequire(electronPackage);
  const { version } = JSON.parse(readFileSync(electronPackage, "utf8")) as { version: string };
  const declared = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
    devDependencies?: { electron?: string };
  };
  if (declared.devDependencies?.electron !== version) {
    throw new Error("Electron must be installed at the exact version pinned by package.json.");
  }
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const executable = executableRelativePath(platform);
  const archiveName = `electron-v${version}-${platform}-${arch}.zip`;
  const checksums = JSON.parse(
    readFileSync(path.join(packageRoot, "checksums.json"), "utf8"),
  ) as Record<string, string>;
  const archiveSha256 = checksums[archiveName];
  if (!archiveSha256 || !/^[a-f0-9]{64}$/u.test(archiveSha256)) {
    throw new Error(`Installed Electron package has no pinned SHA-256 for ${archiveName}.`);
  }
  const identity = `${RECIPE}:${archiveName}:${archiveSha256}`;
  if (validLocalDistribution(packageRoot, identity, version, executable)) {
    return path.join(packageRoot, "dist", executable);
  }

  await ensureImmutableDirectory(
    {
      destinationPath: resolveImmutableDirectoryPath({
        archiveSha256,
        cachePath: options.cachePath,
        directoryName: RECIPE,
        family: "electron",
        projectRoot,
      }),
      label: archiveName,
      generate: async (directory) => {
        // Resolve from Electron so its own pinned downloader/extractor remain the authority.
        const installer = options.installer ?? {
          ...(electronRequire("@electron/get") as Pick<ElectronInstaller, "downloadArtifact">),
          ...(electronRequire("@electron-internal/extract-zip") as Pick<
            ElectronInstaller,
            "extract"
          >),
        };
        const archivePath = await downloadElectronArchive(installer, {
          arch,
          artifactName: "electron",
          checksums,
          platform,
          version,
        });
        const metadata = lstatSync(archivePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error("Electron archive must be a regular file.");
        }
        const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
        if (actual !== archiveSha256)
          throw new Error(`Electron archive checksum mismatch: ${archiveName}`);
        mkdirSync(directory);
        await installer.extract(archivePath, { dir: directory });
        // The npm package already owns its type definitions; upstream also removes this ZIP entry.
        rmSync(path.join(directory, "electron.d.ts"), { force: true });
      },
      validate: (directory) => assertDistribution(directory, version, executable),
    },
    (directory) => {
      if (validLocalDistribution(packageRoot, identity, version, executable)) return;
      const temporary = mkdtempSync(path.join(packageRoot, ".nodex-electron-"));
      try {
        const distribution = path.join(temporary, "dist");
        cloneImmutableDirectory(directory, distribution);
        const digest = immutableDirectoryDigest(distribution);
        replaceOwnedDirectory(distribution, path.join(packageRoot, "dist"));
        writeAtomic(path.join(packageRoot, "path.txt"), executable);
        writeAtomic(
          path.join(packageRoot, RECEIPT_NAME),
          `${JSON.stringify({ identity, digest })}\n`,
        );
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
  if (!existsSync(path.join(packageRoot, "dist", executable))) {
    throw new Error("Electron distribution was not published.");
  }
  return path.join(packageRoot, "dist", executable);
}
