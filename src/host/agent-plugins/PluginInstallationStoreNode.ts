import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  emptyPluginRegistry,
  PLUGIN_REGISTRY_DIRECTORY,
  pluginDataDirectory,
  pluginPackageDirectory,
  type PluginRegistry,
} from "../../shared/agent-plugins/installation-registry";
import type { AgentPluginRejectionReason } from "../../shared/agent-plugins/types";
import { canonicalPackageRoot, copyPackageToStage } from "./PackageFilesNode";
import type {
  PluginCleanupWarning,
  PluginInstallationStore,
  PluginPackageRejected,
  PluginStoreError,
  PluginStoreCommit,
} from "./PluginInstallationStore";
import { pluginRegistrySchema } from "./plugin-registry-schema";

class StoreFailure extends Error {
  constructor(readonly reason: PluginStoreError) {
    super(reason.code);
  }
}

const hasCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && "code" in cause && cause.code === code;

function io<A>(operation: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause): PluginStoreError =>
      cause instanceof StoreFailure ? cause.reason : { code: "store-io", operation },
  });
}

const rejected = (reason: AgentPluginRejectionReason): PluginPackageRejected => ({
  code: "package-rejected",
  reasons: [reason],
});

async function directoryAt(location: string, create = false): Promise<boolean> {
  if (create) {
    await mkdir(location, { mode: 0o700 }).catch((cause: unknown) => {
      if (!hasCode(cause, "EEXIST")) throw cause;
    });
  }
  const info = await lstat(location).catch((cause: unknown) => {
    if (!hasCode(cause, "ENOENT")) throw cause;
  });
  if (!info) return false;
  if (!info.isDirectory()) throw new StoreFailure({ code: "invalid-registry" });
  return true;
}

async function readRegistry(root: string): Promise<PluginRegistry> {
  if (!(await directoryAt(root))) return emptyPluginRegistry;
  const handle = await open(
    path.join(root, "registry.json"),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch((cause: unknown) => {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw cause;
  });
  if (!handle) return emptyPluginRegistry;
  try {
    if (!(await handle.stat()).isFile()) throw new StoreFailure({ code: "invalid-registry" });
    const contents = await handle.readFile("utf8");
    try {
      return pluginRegistrySchema.parse(JSON.parse(contents));
    } catch {
      throw new StoreFailure({ code: "invalid-registry" });
    }
  } finally {
    await handle.close();
  }
}

async function prepareRegistryFile(temporary: string, contents: PluginRegistry) {
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(contents) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const within = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
  );
};

async function packageParent(home: string, directory: string, create: boolean) {
  const parts = directory.split("/").slice(1, -1);
  let parent = path.join(home, PLUGIN_REGISTRY_DIRECTORY);
  for (const part of parts) {
    parent = path.join(parent, part);
    if (!(await directoryAt(parent, create))) return false;
  }
  return true;
}

async function removeGeneration(profile: string, directory: string) {
  if (!(await packageParent(profile, directory, false))) return;
  const location = path.join(profile, directory);
  await rm(location, { force: true, recursive: true });
  await rmdir(path.dirname(location)).catch((cause: unknown) => {
    if (!hasCode(cause, "ENOENT") && !hasCode(cause, "ENOTEMPTY") && !hasCode(cause, "EEXIST"))
      throw cause;
  });
}

async function removeData(profile: string, id: string) {
  const directory = path.join(profile, pluginDataDirectory(id));
  if (await directoryAt(path.dirname(directory)))
    await rm(directory, { force: true, recursive: true });
}

function nextPublication(
  root: string,
  current: PluginRegistry,
  next: PluginRegistry,
  commit?: PluginStoreCommit,
) {
  const previous = new Set(current.installations.map(pluginPackageDirectory));
  const added = next.installations.filter((entry) => !previous.has(pluginPackageDirectory(entry)));
  const stage = commit?.publish;
  if (
    commit?.deleteData &&
    (!current.installations.some(({ id }) => id === commit.deleteData) ||
      next.installations.some(({ id }) => id === commit.deleteData))
  )
    throw new StoreFailure({ code: "invalid-registry" });
  if (added.length === 0 && !stage) return undefined;
  const installation = added[0];
  if (
    added.length !== 1 ||
    !installation ||
    !stage ||
    installation.id !== stage.installationId ||
    path.dirname(stage.directory) !== root ||
    !path.basename(stage.directory).startsWith(".stage-")
  )
    throw new StoreFailure({ code: "invalid-registry" });
  return { stage: stage.directory, relative: pluginPackageDirectory(installation) };
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return hasCode(cause, "ESRCH");
  }
}

async function reclaimWriter(lock: string) {
  if (!(await directoryAt(lock))) return;
  const owners = await readdir(lock).catch((cause: unknown) => {
    if (!hasCode(cause, "ENOENT")) throw cause;
    return [];
  });
  if (owners.length > 0) {
    const [owner] = owners;
    const pid = Number(/^([1-9]\d*)-[a-f0-9-]{36}$/.exec(owner ?? "")?.[1]);
    if (
      owners.length !== 1 ||
      !Number.isSafeInteger(pid) ||
      pid > 0x7fffffff ||
      !processIsGone(pid)
    )
      throw new StoreFailure({ code: "store-busy" });
    // Remove only the observed owner. A replacement lock always contains its own marker.
    await unlink(path.join(lock, owner!)).catch((cause: unknown) => {
      if (!hasCode(cause, "ENOENT")) throw cause;
    });
  }
  await rmdir(lock).catch((cause: unknown) => {
    if (!hasCode(cause, "ENOENT") && !hasCode(cause, "ENOTEMPTY") && !hasCode(cause, "EEXIST"))
      throw cause;
  });
}

async function acquireWriter(root: string) {
  const lock = path.join(root, ".writer");
  const owner = process.pid + "-" + randomUUID();
  const candidate = await mkdtemp(path.join(root, ".writer-"));
  const claim = async () =>
    rename(candidate, lock).catch(async (cause: unknown) => {
      if (!(await directoryAt(lock))) throw cause;
      return false;
    });
  try {
    // Publish the owner and lock atomically so an interrupted claimant never leaves an empty lock.
    await writeFile(path.join(candidate, owner), "", { flag: "wx", mode: 0o600 });
    if ((await claim()) === false) {
      await reclaimWriter(lock);
      if ((await claim()) === false) throw new StoreFailure({ code: "store-busy" });
    }
  } finally {
    await rm(candidate, { force: true, recursive: true });
  }
  return async () => {
    await unlink(path.join(lock, owner));
    await rmdir(lock).catch((cause: unknown) => {
      if (!hasCode(cause, "ENOENT") && !hasCode(cause, "ENOTEMPTY") && !hasCode(cause, "EEXIST"))
        throw cause;
    });
  };
}

export function makePluginInstallationStoreNode(profileHome: string): PluginInstallationStore {
  const home = () => realpath(profileHome);
  const rootAt = (profile: string) => path.join(profile, PLUGIN_REGISTRY_DIRECTORY);

  const read = io("read", async () => readRegistry(rootAt(await home())));
  const createStage = io("create-stage", async () => {
    const root = rootAt(await home());
    await directoryAt(root, true);
    return mkdtemp(path.join(root, ".stage-"));
  });
  const canonicalSource = Effect.fnUntraced(function* (directory: string) {
    const root = yield* io("resolve-profile", async () => rootAt(await home()));
    const source = yield* canonicalPackageRoot(directory).pipe(Effect.mapError(rejected));
    if (within(source, root) || within(root, source))
      return yield* Effect.fail(
        rejected({
          code: "invalid-root",
          message: "A plugin source cannot contain or be inside the Profile's plugin store.",
        }),
      );
    return source;
  });
  const copyToStage = (source: string, stage: string) =>
    copyPackageToStage(source, stage).pipe(Effect.mapError(rejected));
  const discardStage = (directory: string) =>
    io("discard-stage", () => rm(directory, { force: true, recursive: true }));

  const compareAndSwap: PluginInstallationStore["compareAndSwap"] = (expected, next, commit) =>
    io("publish", async () => {
      const profile = await home();
      const root = rootAt(profile);
      await directoryAt(root, true);
      const releaseWriter = await acquireWriter(root);

      const warnings: PluginCleanupWarning[] = [];
      const temporary = path.join(root, ".registry-" + randomUUID());
      let published: string | undefined;
      try {
        const current = await readRegistry(root);
        if (current.revision !== expected)
          throw new StoreFailure({ code: "revision-conflict", expected, actual: current.revision });
        if (next.revision !== expected + 1 || !pluginRegistrySchema.safeParse(next).success)
          throw new StoreFailure({ code: "invalid-registry" });

        const publication = nextPublication(root, current, next, commit);
        await prepareRegistryFile(temporary, next);
        if (publication) {
          const { stage, relative } = publication;
          const destination = path.join(profile, relative);
          if (!(await directoryAt(stage)))
            throw new StoreFailure({ code: "store-io", operation: "publish" });
          await packageParent(profile, relative, true);
          await rename(stage, destination);
          published = destination;
        }

        await rename(temporary, path.join(root, "registry.json"));
        // Everything after this point is cleanup. Never report a failed publication here.
        published = undefined;
        const active = new Set(next.installations.map(pluginPackageDirectory));
        for (const installation of current.installations) {
          const directory = pluginPackageDirectory(installation);
          if (active.has(directory)) continue;
          await removeGeneration(profile, directory).catch(() =>
            warnings.push({ kind: "generation", installationId: installation.id }),
          );
        }
        if (commit?.deleteData) {
          const installationId = commit.deleteData;
          await removeData(profile, installationId).catch(() =>
            warnings.push({ kind: "data", installationId }),
          );
        }
      } finally {
        if (published) await rm(published, { force: true, recursive: true }).catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        await releaseWriter().catch(() => warnings.push({ kind: "writer-lock" }));
      }
      return warnings;
    }).pipe(Effect.uninterruptible);

  return { read, canonicalSource, createStage, copyToStage, discardStage, compareAndSwap };
}
