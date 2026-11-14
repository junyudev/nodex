import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import * as Effect from "effect/Effect";
import { z } from "zod";
import type { FolderPluginPreviewResult } from "../../shared/codex-plugin-management";
import { canonicalPackageRoot, copyPackageSubtrees } from "./PackageFilesNode";
import { describeAgentSupport, pluginPathComponent, pluginReader } from "./PluginCatalog";

export class FolderReviewError extends Error {}

export const LOCAL_MARKETPLACE = "nodex-local";
const stagingIdSchema = z.uuid();
const sourceMap = z.record(z.string(), z.string());
const io = <A>(operation: () => Promise<A>) => Effect.tryPromise(operation);
const errorText = (cause: unknown) =>
  cause && typeof cause === "object" && "message" in cause
    ? String(cause.message)
    : "Could not read the plugin.";

export const makeFolderMarketplace = Effect.fn("FolderMarketplace.make")(function* (home: string) {
  const root = join(home, LOCAL_MARKETPLACE);
  const staging = join(root, "staging");
  const packages = join(root, "plugins");
  const catalogDirectory = join(root, ".agents", "plugins");
  const catalogPath = join(catalogDirectory, "marketplace.json");
  const sourcePath = join(root, "sources.json");
  const stages = new Map<string, { folder: string; name: string; digest: string }>();
  yield* io(() => rm(staging, { recursive: true, force: true }));
  const sources = io(async () => {
    try {
      return sourceMap.parse(JSON.parse(await readFile(sourcePath, "utf8")));
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
        return {};
      throw cause;
    }
  });
  const atomicJson = async (path: string, data: unknown) => {
    const temp = path + "." + randomUUID();
    try {
      await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  };
  const writeCatalog = (entries: Record<string, string>) =>
    atomicJson(catalogPath, {
      name: LOCAL_MARKETPLACE,
      interface: { displayName: "Local folders" },
      plugins: Object.keys(entries)
        .sort()
        .map((name) => ({
          name,
          source: { source: "local", path: "./plugins/" + name },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        })),
    });
  const discard = Effect.fn("FolderMarketplace.discard")(function* (id: string) {
    if (!stagingIdSchema.safeParse(id).success) return;
    stages.delete(id);
    yield* io(() => rm(join(staging, id), { recursive: true, force: true }));
  });
  const prepare = Effect.fn("FolderMarketplace.prepare")(function* (
    folder: string,
    installedIds: ReadonlySet<string>,
    authorizeLogo?: (path: string) => string | null,
  ) {
    const id = randomUUID();
    const stage = join(staging, id);
    const reject = (reasons: readonly string[]): FolderPluginPreviewResult => ({
      status: "rejected",
      folder,
      reasons,
    });
    return yield* Effect.gen(function* (): Effect.fn.Return<FolderPluginPreviewResult, unknown> {
      if (!isAbsolute(folder)) return reject(["Choose an absolute folder path."]);
      const source = yield* canonicalPackageRoot(folder);
      const marketplaceRoot = yield* canonicalPackageRoot(home);
      const market = join(marketplaceRoot, LOCAL_MARKETPLACE);
      const inside = (parent: string, child: string) => {
        const path = relative(parent, child);
        return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
      };
      if (inside(source, market) || inside(market, source))
        return reject(["Choose a folder outside the plugin marketplace."]);
      yield* io(() => mkdir(staging, { recursive: true, mode: 0o700 }));
      yield* copyPackageSubtrees(source, [{ source: ".", target: stage }]);
      const result = yield* pluginReader.read(stage);
      if (result.status === "rejected") return reject(result.reasons.map(({ message }) => message));
      const pkg = result.package;
      const { name, version, description, author } = pkg.identity;
      if (!pluginPathComponent(name))
        return reject(["The plugin name cannot be used in a marketplace."]);
      stages.set(id, { folder: source, name, digest: pkg.digest });
      const pluginId = name + "@" + LOCAL_MARKETPLACE;
      return {
        status: "ready",
        preview: {
          stagingId: id,
          folder,
          name,
          version: version ?? null,
          description: description ?? pkg.presentation?.shortDescription ?? null,
          displayName: pkg.presentation?.displayName ?? null,
          developer: pkg.presentation?.developerName ?? author?.name ?? null,
          logoUrl: pkg.presentation?.logo
            ? (authorizeLogo?.(join(stage, pkg.presentation.logo)) ?? null)
            : null,
          skills: pkg.skills
            .filter(({ valid }) => valid)
            .map(({ name, description }) => ({ name, description })),
          mcpServers: pkg.mcpServers.map(({ key, transport }) => ({
            key,
            launch:
              transport.type === "stdio"
                ? [transport.command, ...transport.args]
                    .map((arg) => (/^[\w./-]+$/u.test(arg) ? arg : JSON.stringify(arg)))
                    .join(" ")
                : transport.url.replace(/[?#].*$/u, ""),
          })),
          hookCount: pkg.hooks.reduce(
            (count, hooks) =>
              count + hooks.events.reduce((total, event) => total + event.commands.length, 0),
            0,
          ),
          connectedAppCount: pkg.apps.length,
          agentSupport: describeAgentSupport(pkg),
          replacesPluginId: installedIds.has(pluginId) ? pluginId : null,
          warnings: pkg.diagnostics.map(({ message }) => message),
        },
      };
    }).pipe(
      Effect.catch((error) => Effect.succeed(reject([errorText(error)]))),
      Effect.ensuring(
        Effect.suspend(() => (stages.has(id) ? Effect.void : discard(id).pipe(Effect.ignore))),
      ),
    );
  });

  const install = Effect.fn("FolderMarketplace.install")(function* <E>(
    id: string,
    nativeInstall: (root: string, catalog: string, name: string) => Effect.Effect<unknown, E>,
  ) {
    const stage = stages.get(id);
    if (!stage) return yield* Effect.fail(new FolderReviewError("This folder review has expired."));
    const target = join(packages, stage.name);
    const reviewed = join(staging, id);
    const confirmed = yield* pluginReader.read(reviewed);
    if (confirmed.status !== "loaded" || confirmed.package.digest !== stage.digest)
      return yield* Effect.fail(
        new FolderReviewError("The reviewed folder copy changed. Open the folder again."),
      );
    const backup = join(staging, id + "-previous");
    const previous = yield* sources;
    const next = { ...previous, [stage.name]: stage.folder };
    yield* io(async () => {
      await mkdir(packages, { recursive: true, mode: 0o700 });
      await mkdir(catalogDirectory, { recursive: true, mode: 0o700 });
    });
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const backedUp = yield* io(async () => {
          try {
            await rename(target, backup);
            return true;
          } catch (cause) {
            if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
              return false;
            throw cause;
          }
        });
        let moved = false;
        yield* Effect.gen(function* () {
          yield* io(async () => {
            await rename(reviewed, target);
            moved = true;
            await writeCatalog(next);
            await atomicJson(sourcePath, next);
          });
          yield* nativeInstall(root, catalogPath, stage.name);
        }).pipe(
          Effect.onError(() =>
            io(async () => {
              if (moved) await rename(target, reviewed);
              if (backedUp) await rename(backup, target);
              await writeCatalog(previous);
              await atomicJson(sourcePath, previous);
            }).pipe(Effect.ignore),
          ),
        );
        stages.delete(id);
        if (backedUp)
          yield* io(() => rm(backup, { recursive: true, force: true })).pipe(Effect.ignore);
        return {
          pluginId: stage.name + "@" + LOCAL_MARKETPLACE,
          selector: { marketplacePath: catalogPath, pluginName: stage.name },
        };
      }),
    );
  });

  const remove = Effect.fn("FolderMarketplace.remove")(function* (name: string) {
    if (!pluginPathComponent(name)) return;
    const entries = yield* sources;
    if (!Object.hasOwn(entries, name)) return;
    delete entries[name];
    yield* io(async () => {
      await writeCatalog(entries);
      await rm(join(packages, name), { recursive: true, force: true });
      await atomicJson(sourcePath, entries);
    });
  });

  return { sources, prepare, install, discard, remove, catalogPath };
});
