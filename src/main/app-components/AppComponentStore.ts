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
  type AppComponentDefinition,
  type AppComponentTarget,
} from "./AppComponentCatalog";
import { BROWSER_RUNTIME_BUNDLE_DIRECTORY } from "../../shared/browser-runtime-metadata";
import { extractPinnedTarArchive, verifyGzipExpansion } from "../platform/node/pinned-tar-archive";
import { stageDocumentTools } from "../platform/node/stage-document-tools";
import { stageClaudeCode } from "../platform/node/stage-claude-code";
import { stageMacBrowserRuntime } from "../platform/node/stage-mac-browser-runtime";
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
  readonly target: AppComponentTarget;
  readonly signal?: AbortSignal;
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

const remove = (file: string): Promise<void> => rm(file, { force: true, recursive: true });

async function setMarker(marker: string, present: boolean): Promise<void> {
  if (!present) return rm(marker, { force: true });
  await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, "", { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

export const setAppComponentTombstone = (home: string, id: AppComponentId, pending: boolean) =>
  setMarker(appComponentRemovalMarker(home, id), pending);

export async function hasAppComponentTombstone(home: string, id: AppComponentId): Promise<boolean> {
  return (await lstat(appComponentRemovalMarker(home, id)).catch(missing)) !== null;
}

export const setAppComponentWanted = (home: string, id: AppComponentId, requested: boolean) =>
  setMarker(wanted(home, id), requested);

export async function hasAppComponentWanted(home: string, id: AppComponentId): Promise<boolean> {
  return (await lstat(wanted(home, id)).catch(missing))?.isFile() ?? false;
}

async function readNextComponents(home: string): Promise<NextComponents | null> {
  const file = nextRecordPath(home);
  if (!(await lstat(file).catch(missing))?.isFile()) return null;
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(missing);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
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
    await rename(staging, file);
  } finally {
    await remove(temporary);
  }
}

/** Replace the single next-build record and reclaim pins only the previous record referenced. */
export async function updateNextAppComponents(
  { home, target }: AppComponentStoreInput,
  update: (previous: NextComponents | null) => NextComponents | null,
): Promise<void> {
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
      await remove(path.join(appComponentStoreRoot(home), id, sha256));
    if (!retained.some((pin) => pin.sha256 === sha256))
      await remove(path.join(downloads(home), `${sha256}.part`));
  }
}

/**
 * Complete deferred removals and collect superseded files before startup resolution. The
 * Component's removal and use preferences belong to the Component, across all archive pins.
 */
export async function prepareAppComponentStore(
  input: AppComponentStoreInput & { readonly appBuildVersion?: string | null },
): Promise<void> {
  const { home, target, signal } = input;
  const catalog = appComponentCatalog(target);
  // A build that ships everything inside the app leaves another build's store alone.
  if (catalog.length === 0) return;
  signal?.throwIfAborted();
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
  if (!next || retainedNext.length !== next.components.length) {
    await writeNextComponents(
      home,
      next && retainedNext.length ? { ...next, components: retainedNext } : null,
    );
  }
  const pins = [
    ...catalog
      .filter(({ id }) => enabled.has(id))
      .map(({ id, archive }) => ({ id, sha256: archive.sha256 })),
    ...retainedNext,
  ];
  const partials = new Set(pins.map(({ sha256 }) => `${sha256}.part`));
  for (const entry of await directoryEntries(appComponentStoreRoot(home))) {
    signal?.throwIfAborted();
    const directory = path.join(entry.parentPath, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".next-")) {
      await remove(directory);
      continue;
    }
    if (entry.name === "downloads") {
      for (const file of await directoryEntries(directory)) {
        signal?.throwIfAborted();
        if (!partials.has(file.name) || !file.isFile())
          await remove(path.join(directory, file.name));
      }
      continue;
    }
    const children = await directoryEntries(directory);
    const tombstoned = children.some((child) => child.name === ".remove");
    for (const child of children) {
      signal?.throwIfAborted();
      if (child.name === ".remove") continue;
      if (child.name === ".wanted" && !tombstoned && child.isFile()) continue;
      if (
        !child.isDirectory() ||
        !pins.some(({ id, sha256 }) => id === entry.name && sha256 === child.name)
      ) {
        await remove(path.join(directory, child.name));
      }
    }
  }
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
  return stats?.isDirectory() ? root : null;
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
  home: string,
  definition: AppComponentDefinition,
): Promise<number | null> {
  const receipt = await readFile(path.join(appComponentRoot(home, definition), receiptName)).catch(
    missing,
  );
  if (!receipt) return null;
  if (receipt.byteLength !== 8) throw new Error("Component installation receipt is invalid.");
  const size = Number(receipt.readBigUInt64LE());
  if (!Number.isSafeInteger(size) || size < receipt.byteLength) {
    throw new Error("Component installation size is invalid.");
  }
  return size;
}

export async function removeAppComponentFiles(
  home: string,
  definition: AppComponentDefinition,
  active: boolean,
): Promise<void> {
  if (!active) await remove(appComponentRoot(home, definition));
  await remove(partial(home, definition));
}

export async function installAppComponent(input: {
  readonly home: string;
  readonly definition: AppComponentDefinition;
  readonly fetch: ComponentFetch;
  readonly signal: AbortSignal;
  readonly onProgress: (received: number) => void;
  readonly onInstalling: () => void;
  /** This archive pin was advertised by a future release, so enforce its unpacking budget. */
  readonly prefetch?: true;
}): Promise<number> {
  const { home, definition, signal } = input;
  const root = appComponentRoot(home, definition);
  const file = partial(home, definition);
  let staging: string | undefined;
  try {
    signal.throwIfAborted();
    await mkdir(downloads(home), { recursive: true, mode: 0o700 });
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
    await downloadComponentArchive({ ...input, archive: definition.archive, file });
    getLogger({ component: definition.id }).info("Component archive verified", {
      downloadMs: Math.round(performance.now() - downloadStartedAt),
    });
    signal.throwIfAborted();
    input.onInstalling();
    await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    staging = await mkdtemp(path.join(path.dirname(root), ".stage-"));
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
      await extractPinnedTarArchive(file, payload, signal);
      if (definition.payload.kind === "desktop-tools") {
        size = await stageMacBrowserRuntime(payload, definition.payload.manifestSha256, signal);
      } else if (definition.payload.kind === "claude-code") {
        size = await stageClaudeCode(payload, definition.payload, signal);
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

    const installedBytes = await writeAppComponentReceipt(staging, size);
    signal.throwIfAborted();
    await rename(staging, root);
    staging = undefined;
    await rm(file, { force: true });
    return installedBytes;
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOSPC") {
      throw new AppComponentInstallError(
        "disk-space",
        "There is not enough space to install this component.",
      );
    }
    if (error instanceof AppComponentInstallError && error.reason === "integrity")
      await remove(file);
    throw error;
  } finally {
    if (staging) await remove(staging);
  }
}
