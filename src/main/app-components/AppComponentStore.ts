/* @effect-diagnostics asyncFunction:off -- Node filesystem adapter and bootstrap path authority. */
import { constants, type Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { APP_COMPONENT_IDS, type AppComponentId } from "../../shared/app-components";
import {
  appComponentArchiveSha,
  appComponentBuildVersion,
} from "../../shared/app-component-manifest";
import { appBuildOrdinal } from "../../shared/app-version";
import { getLogger } from "../logging/logger";
import {
  appComponentCatalog,
  appComponentDefinition,
  appComponentTargetKey,
  type AppComponentDefinition,
  type AppComponentTarget,
} from "./AppComponentCatalog";
import { BROWSER_RUNTIME_BUNDLE_DIRECTORY } from "../../shared/browser-runtime-metadata";
import { extractPinnedTarArchive, verifyGzipExpansion } from "../platform/node/pinned-tar-archive";
import { stageDocumentTools } from "../platform/node/stage-document-tools";
import {
  codexSeedRoots,
  copyCodexSeed,
  type CodexSeedSearch,
} from "../platform/node/seed-codex-package";
import { codexCrtDirectories, stageCodexPackage } from "../platform/node/stage-codex-package";
import { stageClaudeCode } from "../platform/node/stage-claude-code";
import { stageMacBrowserRuntime } from "../platform/node/stage-mac-browser-runtime";
import { stageWindowsBrowserRuntime } from "../platform/node/stage-windows-browser-runtime";
import { resolveCoreExecutable } from "../core-client/core-launcher";
import {
  ensurePrivateDirectoryBoundary,
  verifyPrivateDirectoryDescendant,
} from "../platform/node/private-filesystem";
import {
  AppComponentInstallError,
  componentPartialSize,
  downloadComponentArchive,
  type ComponentFetch,
} from "./AppComponentDownload";

/**
 * Installed components live in the Profile, outside the app bundle, one directory per pinned
 * archive: `<Profile>/components/<id>/<archive sha256>/`. A directory at that path is complete:
 * installs unpack beside it and publish with one rename.
 */
export const appComponentStoreRoot = (home: string): string => path.join(home, "components");

export const appComponentRoot = (home: string, definition: AppComponentDefinition): string =>
  path.join(appComponentStoreRoot(home), definition.id, definition.archive.sha256);

export interface AppComponentStoreInput {
  readonly home: string;
  readonly target: AppComponentTarget & {
    readonly resourcesPath?: string;
    readonly projectRootPath?: string;
    readonly coreExecutable?: string;
  };
  readonly signal?: AbortSignal;
}

function windowsStoreCore({ target }: AppComponentStoreInput): string | null {
  if (process.platform !== "win32" || target.platform !== "win32") return null;
  return (
    target.coreExecutable ??
    resolveCoreExecutable({
      isPackaged: target.isPackaged,
      appResourcesPath: target.resourcesPath,
      repositoryRoot: target.projectRootPath,
      environment: target.environment,
    })
  );
}

/** The store boundary exists before any Component directory or executable is written. */
export async function ensureAppComponentStoreBoundary(
  input: AppComponentStoreInput,
): Promise<void> {
  input.signal?.throwIfAborted();
  const core = windowsStoreCore(input);
  if (!core) return;
  const profile = input.target.headless ? path.resolve(input.home, "../..") : input.home;
  await ensurePrivateDirectoryBoundary(core, profile, appComponentStoreRoot(input.home)).catch(
    (cause: unknown) => {
      input.signal?.throwIfAborted();
      throw new AppComponentInstallError(
        "location",
        "Other accounts can change this Profile's folder, so Nodex can't keep Components private there.",
        { cause },
      );
    },
  );
  input.signal?.throwIfAborted();
}

/** Check an existing directory before traversing or admitting it on Windows. */
export async function verifyAppComponentDirectory(
  input: AppComponentStoreInput,
  directory: string,
): Promise<void> {
  const core = windowsStoreCore(input);
  if (core)
    await verifyPrivateDirectoryDescendant(core, appComponentStoreRoot(input.home), directory);
}

/** New children inherit the protected store DACL. Existing paths also need native admission. */
async function ensureStoreChild(input: AppComponentStoreInput, directory: string): Promise<void> {
  if (windowsStoreCore(input)) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await verifyAppComponentDirectory(input, directory);
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

export const appComponentRemovalMarker = (home: string, id: AppComponentId): string =>
  path.join(appComponentStoreRoot(home), id, ".remove");
const wanted = (home: string, id: AppComponentId): string =>
  path.join(appComponentStoreRoot(home), id, ".wanted");
const downloads = (home: string): string => path.join(appComponentStoreRoot(home), "downloads");
const partial = (home: string, definition: AppComponentDefinition): string =>
  path.join(downloads(home), `${definition.archive.sha256}.part`);
const receiptName = ".installed-size";
const nextRecordPath = (home: string) => path.join(appComponentStoreRoot(home), "next.json");
const nextRecordMaxBytes = 4096;
const nextRecordSchema = z.strictObject({
  buildVersion: appComponentBuildVersion,
  components: z
    .array(
      z.strictObject({
        id: z.enum(APP_COMPONENT_IDS),
        sha256: appComponentArchiveSha,
      }),
    )
    .min(1)
    .max(APP_COMPONENT_IDS.length)
    .refine((components) => new Set(components.map(({ id }) => id)).size === components.length),
});
type NextComponents = z.infer<typeof nextRecordSchema>;

const missing = (error: NodeJS.ErrnoException): null => {
  if (error.code === "ENOENT") return null;
  throw error;
};

const directoryEntries = async (directory: string): Promise<Dirent[]> =>
  (await readdir(directory, { withFileTypes: true }).catch(missing)) ?? [];

const windowsRetries = process.platform === "win32" ? 4 : 0;
const remove = (file: string): Promise<void> =>
  rm(file, { force: true, recursive: true, maxRetries: windowsRetries, retryDelay: 100 });

async function replaceWithRetry(
  source: string,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= windowsRetries || !["EPERM", "EACCES", "EBUSY"].includes(code ?? ""))
        throw error;
      await delay(100 * (attempt + 1), undefined, { signal });
    }
  }
}

async function cleanup(file: string): Promise<void> {
  await remove(file).catch((cause: unknown) => {
    getLogger().warn("Could not reclaim Component files", { file, cause: String(cause) });
  });
}

async function setMarker(
  input: AppComponentStoreInput,
  marker: string,
  present: boolean,
): Promise<void> {
  await ensureAppComponentStoreBoundary(input);
  const parent = path.dirname(marker);
  if (present) await ensureStoreChild(input, parent);
  else {
    if (!(await lstat(parent).catch(missing))) return;
    await verifyAppComponentDirectory(input, parent);
    return remove(marker);
  }
  await writeFile(marker, "", { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

export const setAppComponentTombstone = (
  input: AppComponentStoreInput,
  id: AppComponentId,
  pending: boolean,
) => setMarker(input, appComponentRemovalMarker(input.home, id), pending);

export async function hasAppComponentTombstone(home: string, id: AppComponentId): Promise<boolean> {
  return (await lstat(appComponentRemovalMarker(home, id)).catch(missing)) !== null;
}

export const setAppComponentWanted = (
  input: AppComponentStoreInput,
  id: AppComponentId,
  requested: boolean,
) => setMarker(input, wanted(input.home, id), requested);

export async function hasAppComponentWanted(home: string, id: AppComponentId): Promise<boolean> {
  return (await lstat(wanted(home, id)).catch(missing))?.isFile() ?? false;
}

async function readNextComponents(home: string): Promise<NextComponents | null> {
  const file = nextRecordPath(home);
  if (!(await lstat(file).catch(missing))?.isFile()) return null;
  const handle = await open(
    file,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  ).catch(missing);
  if (!handle) return null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) return null;
    const buffer = Buffer.alloc(nextRecordMaxBytes + 1);
    const { bytesRead } = await handle.read(buffer);
    if (bytesRead > nextRecordMaxBytes) return null;
    try {
      return (
        nextRecordSchema.safeParse(JSON.parse(buffer.toString("utf8", 0, bytesRead))).data ?? null
      );
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

async function writeNextComponents(home: string, next: NextComponents | null): Promise<void> {
  const file = nextRecordPath(home);
  if (!next?.components.length) return remove(file);
  const record = nextRecordSchema.parse(next);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(path.dirname(file), ".next-"));
  try {
    const staging = path.join(temporary, "next.json");
    await writeFile(staging, JSON.stringify(record), { mode: 0o600 });
    await replaceWithRetry(staging, file);
  } finally {
    await cleanup(temporary);
  }
}

/** Replace the single next-build record and reclaim pins only the previous record referenced. */
export async function updateNextAppComponents(
  input: AppComponentStoreInput,
  update: (previous: NextComponents | null) => NextComponents | null,
): Promise<void> {
  const { home, target } = input;
  await ensureAppComponentStoreBoundary(input);
  const previous = await readNextComponents(home);
  const next = update(previous);
  if (next === previous) return;
  await writeNextComponents(home, next);
  const retained = [
    ...appComponentCatalog(target).map(({ id, archive }) => ({ id, sha256: archive.sha256 })),
    ...(next?.components ?? []),
  ];
  for (const { id, sha256 } of previous?.components ?? []) {
    if (!retained.some((pin) => pin.id === id && pin.sha256 === sha256))
      await reclaimStoreEntry(input, path.join(appComponentStoreRoot(home), id, sha256));
    if (!retained.some((pin) => pin.sha256 === sha256))
      await reclaimStoreEntry(input, path.join(downloads(home), `${sha256}.part`));
  }
}

async function reclaimStoreEntry(input: AppComponentStoreInput, file: string): Promise<boolean> {
  try {
    if (!(await lstat(file).catch(missing))) return true;
    await verifyAppComponentDirectory(input, path.dirname(file));
    await remove(file);
    return true;
  } catch (cause) {
    getLogger().warn("Could not reclaim Component files", { file, cause: String(cause) });
    return false;
  }
}

/** Plan the sweep before startup activation. Its deletion retries can run in the background. */
export async function prepareAppComponentStoreSweep(
  input: AppComponentStoreInput & { readonly appBuildVersion?: string | null },
): Promise<() => Promise<void>> {
  const { home, target, signal } = input;
  const catalog = appComponentCatalog(target);
  if (catalog.length === 0) return async () => {};
  await ensureAppComponentStoreBoundary(input);
  const enabled = new Set<AppComponentId>();
  for (const { id } of catalog) {
    if (!(await hasAppComponentTombstone(home, id))) enabled.add(id);
  }
  const next = await readNextComponents(home);
  const runningBuild = appBuildOrdinal(input.appBuildVersion);
  const nextBuild = appBuildOrdinal(next?.buildVersion);
  const retainedNext =
    runningBuild !== null && nextBuild !== null && nextBuild > runningBuild
      ? (next?.components.filter(({ id }) => enabled.has(id)) ?? [])
      : [];
  if (next && retainedNext.length !== next.components.length) {
    await writeNextComponents(
      home,
      retainedNext.length ? { ...next, components: retainedNext } : null,
    ).catch((cause: unknown) => {
      getLogger().warn("Could not update the Component store's next build", {
        cause: String(cause),
      });
    });
  }
  const pins = [
    ...catalog
      .filter(({ id }) => enabled.has(id))
      .map(({ id, archive }) => ({ id, sha256: archive.sha256 })),
    ...retainedNext,
  ];
  const partials = new Set(pins.map(({ sha256 }) => `${sha256}.part`));
  const groups: string[][] = [];
  for (const entry of await directoryEntries(appComponentStoreRoot(home))) {
    signal?.throwIfAborted();
    const directory = path.join(entry.parentPath, entry.name);
    if (entry.name.startsWith(".next-")) {
      groups.push([directory]);
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      await verifyAppComponentDirectory(input, directory);
      const children = await directoryEntries(directory);
      const tombstoned = children.some((child) => child.name === ".remove");
      const stale = children.filter((child) => {
        if (entry.name === "downloads") return !partials.has(child.name) || !child.isFile();
        if (child.name === ".remove") return false;
        if (child.name === ".wanted" && !tombstoned && child.isFile()) return false;
        return (
          !child.isDirectory() ||
          !pins.some(({ id, sha256 }) => id === entry.name && sha256 === child.name)
        );
      });
      groups.push(stale.map((child) => path.join(directory, child.name)));
    } catch (cause) {
      getLogger().warn("Could not inspect Component files for cleanup", {
        directory,
        cause: String(cause),
      });
    }
  }
  return async () => {
    await Promise.all(
      groups.map(async (files) => {
        for (const file of files) {
          if (signal?.aborted) return;
          await reclaimStoreEntry(input, file);
        }
      }),
    );
  };
}

/** The pinned root if published and eligible for startup activation. */
export async function installedAppComponentRoot(
  input: AppComponentStoreInput & { readonly id: AppComponentId },
): Promise<string | null> {
  input.signal?.throwIfAborted();
  const definition = appComponentDefinition(input.target, input.id);
  if (!definition || (await hasAppComponentTombstone(input.home, input.id))) return null;
  const root = appComponentRoot(input.home, definition);
  const stats = await lstat(root).catch(missing);
  if (!stats?.isDirectory()) return null;
  await verifyAppComponentDirectory(input, root);
  return root;
}

/** Finish a private component root before publishing it. Count the receipt in the on-disk size. */
export async function writeAppComponentReceipt(
  root: string,
  payloadBytes: number,
): Promise<number> {
  const receipt = Buffer.alloc(8);
  const installedBytes = payloadBytes + receipt.byteLength;
  receipt.writeBigUInt64LE(BigInt(installedBytes));
  await writeFile(path.join(root, receiptName), receipt, { flag: "wx", mode: 0o600 });
  return installedBytes;
}

/** Read the receipt even when this process is still using a tombstoned installation. */
export async function installedAppComponentBytes(
  input: AppComponentStoreInput,
  definition: AppComponentDefinition,
): Promise<number | null> {
  const root = appComponentRoot(input.home, definition);
  const file = path.join(root, receiptName);
  const stats = await lstat(file).catch(missing);
  if (!stats) return null;
  if (!stats.isFile() || stats.nlink !== 1 || stats.size !== 8) {
    throw new Error("Component installation receipt is invalid.");
  }
  await verifyAppComponentDirectory(input, root);
  const receipt = await readFile(file).catch(missing);
  if (!receipt) return null;
  if (receipt.byteLength !== 8) throw new Error("Component installation receipt is invalid.");
  const size = Number(receipt.readBigUInt64LE());
  if (!Number.isSafeInteger(size) || size < receipt.byteLength) {
    throw new Error("Component installation size is invalid.");
  }
  return size;
}

export async function removeAppComponentRoot(
  input: AppComponentStoreInput,
  definition: AppComponentDefinition,
): Promise<void> {
  const root = appComponentRoot(input.home, definition);
  if (!(await lstat(root).catch(missing))) return;
  await verifyAppComponentDirectory(input, path.dirname(root));
  await remove(root);
}

export async function removeAppComponentFiles(
  input: AppComponentStoreInput,
  definition: AppComponentDefinition,
  active: boolean,
): Promise<boolean> {
  const { home } = input;
  const [removed] = await Promise.all([
    active ? false : reclaimStoreEntry(input, appComponentRoot(home, definition)),
    reclaimStoreEntry(input, partial(home, definition)),
  ]);
  return removed;
}

export async function installAppComponent(
  input: AppComponentStoreInput & {
    readonly definition: AppComponentDefinition;
    readonly fetch: ComponentFetch;
    readonly signal: AbortSignal;
    readonly onProgress: (received: number) => void;
    readonly onInstalling: () => void;
    /** This archive pin was advertised by a future release, so enforce its unpacking budget. */
    readonly prefetch?: true;
    readonly codexNoticesDirectory?: string;
    readonly codexSeedSearch?: CodexSeedSearch & {
      readonly artifactSizes: Readonly<Record<string, number>>;
    };
  },
): Promise<number> {
  const { home, definition, signal, target } = input;
  const targetKey = appComponentTargetKey(target);
  if (!targetKey) throw new Error("This host does not support App Components.");
  const windows = target.platform === "win32";
  const root = appComponentRoot(home, definition);
  const file = partial(home, definition);
  let staging: string | undefined;
  const createStage = async () => {
    await ensureStoreChild(input, path.dirname(root));
    return mkdtemp(path.join(path.dirname(root), ".stage-"));
  };
  const publish = async (stage: string, size: number) => {
    const installedBytes = await writeAppComponentReceipt(stage, size);
    signal.throwIfAborted();
    await replaceWithRetry(stage, root, signal);
    staging = undefined;
    await cleanup(file);
    return installedBytes;
  };
  const logger = getLogger({ component: definition.id });
  try {
    await ensureAppComponentStoreBoundary(input);
    const { codexSeedSearch, codexNoticesDirectory } = input;
    const payloadPin = definition.payload;
    if (
      target.platform === "darwin" &&
      !input.prefetch &&
      payloadPin.kind === "codex" &&
      codexSeedSearch &&
      codexNoticesDirectory
    ) {
      const started = performance.now();
      for await (const source of codexSeedRoots(codexSeedSearch, signal)) {
        input.onInstalling();
        const stage = await createStage();
        staging = stage;
        const seeded = await (async () => {
          if (!(await copyCodexSeed(source, stage, codexSeedSearch.artifactSizes, signal)))
            return null;
          return stageCodexPackage(stage, codexNoticesDirectory, payloadPin, signal);
        })().catch(() => {
          signal.throwIfAborted();
          return null;
        });
        if (seeded !== null) {
          const bytes = await publish(stage, seeded);
          logger.info("Component installed from matching local files", {
            seedMs: Math.round(performance.now() - started),
          });
          return bytes;
        }
        await remove(staging);
        staging = undefined;
      }
    }
    await ensureStoreChild(input, downloads(home));
    const [space, downloaded] = await Promise.all([
      statfs(downloads(home), { bigint: true }),
      componentPartialSize(file),
    ]);
    // Reserve extra space for filesystem allocation and work that may run alongside the install.
    // The expansion budget includes tar headers and filesystem allocation slack.
    const metadataBytes = input.prefetch ? 4 * 1024 * 1024 : 0;
    const requiredBytes =
      Math.ceil((definition.archive.size + definition.unpackedBytes) * 1.2) + metadataBytes;
    if (
      space.bavail * space.bsize + BigInt(Math.min(downloaded, definition.archive.size)) <
      BigInt(requiredBytes)
    ) {
      throw new AppComponentInstallError(
        "disk-space",
        "There is not enough space to install this component.",
      );
    }
    const downloadStartedAt = performance.now();
    logger.info("Preparing Component archive download");
    await downloadComponentArchive({ ...input, archive: definition.archive, file });
    logger.info("Component archive verified", {
      downloadMs: Math.round(performance.now() - downloadStartedAt),
    });
    signal.throwIfAborted();
    // A future Codex pin needs its own build's metadata recipe and notices. Keep the verified
    // archive under its pin so the next build can finish it without downloading again.
    if (input.prefetch && definition.payload.kind === "codex") return 0;
    input.onInstalling();
    staging = await createStage();
    const payload =
      definition.payload.kind === "desktop-tools"
        ? path.join(staging, BROWSER_RUNTIME_BUNDLE_DIRECTORY)
        : staging;
    if (payload !== staging) await mkdir(payload, { mode: 0o755 });
    let size: number;
    try {
      if (input.prefetch) {
        await verifyGzipExpansion(
          file,
          Math.ceil(definition.unpackedBytes * 1.2) + metadataBytes,
          signal,
        );
      }
      await extractPinnedTarArchive(file, payload, signal, { windows });
      if (definition.payload.kind === "desktop-tools") {
        const stageBrowserRuntime = windows ? stageWindowsBrowserRuntime : stageMacBrowserRuntime;
        size = await stageBrowserRuntime(payload, definition.payload.manifestSha256, signal);
      } else if (definition.payload.kind === "claude-code") {
        size = await stageClaudeCode(payload, definition.payload, signal);
      } else if (definition.payload.kind === "codex") {
        if (!input.codexNoticesDirectory) throw new Error("Codex license and notice are missing.");
        size = await stageCodexPackage(
          payload,
          input.codexNoticesDirectory,
          definition.payload,
          signal,
          targetKey,
          codexCrtDirectories(target),
        );
      } else {
        size = await stageDocumentTools(payload, definition.payload, signal);
      }
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOSPC") throw error;
      throw new AppComponentInstallError(
        "integrity",
        "The component archive failed verification.",
        { cause: error },
      );
    }

    return await publish(staging, size);
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOSPC") {
      throw new AppComponentInstallError(
        "disk-space",
        "There is not enough space to install this component.",
      );
    }
    if (error instanceof AppComponentInstallError && error.reason === "integrity")
      await cleanup(file);
    throw error;
  } finally {
    if (staging) await cleanup(staging);
  }
}
