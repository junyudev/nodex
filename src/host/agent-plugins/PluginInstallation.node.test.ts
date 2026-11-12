import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  PLUGIN_REGISTRY_DIRECTORY,
  pluginDataDirectory,
  pluginPackageDirectory,
} from "../../shared/agent-plugins/installation-registry";
import { PORTABLE_1_0_MANIFEST_SCHEMA } from "../../shared/agent-plugins/portable-1.0.0";
import { makeAgentPluginReader } from "./AgentPluginReader";
import { packageFilesNode } from "./PackageFilesNode";
import { makePluginInstallation } from "./PluginInstallation";
import { makePluginInstallationStoreNode } from "./PluginInstallationStoreNode";

const reader = makeAgentPluginReader(packageFilesNode);
const project = { spaceId: "personal", projectId: "project-a" };

const testProfile = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-plugin-install-"))),
  (root) => Effect.promise(() => rm(root, { force: true, recursive: true })),
).pipe(
  Effect.flatMap((root) =>
    Effect.promise(async () => {
      const home = join(root, "profile");
      const locator = join(root, "source");
      await mkdir(home);
      await cp(join(import.meta.dirname, "fixtures", "installation"), locator, { recursive: true });
      const store = makePluginInstallationStoreNode(home);
      return {
        home,
        source: { kind: "local", locator } as const,
        store,
        plugins: makePluginInstallation(reader, store, randomUUID),
      };
    }),
  ),
);

function updateManifest(locator: string, identity: { name: string; version: string }) {
  return Effect.promise(() =>
    writeFile(
      join(locator, "plugin.json"),
      JSON.stringify({ $schema: PORTABLE_1_0_MANIFEST_SCHEMA, ...identity }),
    ),
  );
}

it.effect("publishes verified bytes and exposes them only to the activated Project", () =>
  Effect.gen(function* () {
    const { home, source, plugins } = yield* testProfile;
    const { installation, cleanupWarnings } = yield* plugins.install(source);
    expect(cleanupWarnings).toEqual([]);
    expect(installation).toMatchObject({
      admission: "admitted",
      source: { locator: yield* Effect.promise(() => realpath(source.locator)) },
      package: {
        identity: { name: "sample.organizer", version: "1.0.0" },
        digest: /^[a-f0-9]{64}$/,
      },
    });
    const reopened = makePluginInstallation(
      reader,
      makePluginInstallationStoreNode(home),
      randomUUID,
    );
    expect((yield* reopened.list).installations).toEqual([installation]);
    expect(yield* reopened.contributions(project)).toEqual([]);

    yield* reopened.setProjectEnabled(installation.id, project, true);
    const [contributions] = yield* plugins.contributions(project);
    expect(contributions?.mcpServers[0]?.transport.type).toBe("streamable-http");
    expect(yield* plugins.contributions({ ...project, projectId: "project-b" })).toEqual([]);
    expect(yield* plugins.contributions({ ...project, spaceId: "team" })).toEqual([]);

    const skill = contributions!.skills[0]!;
    expect(skill.name).toBe("organize");
    const supportingFile = join(home, skill.directory, "categories.txt");
    expect(yield* Effect.promise(() => readFile(supportingFile, "utf8"))).toContain("Supplies");
  }).pipe(Effect.scoped),
);

it.effect(
  "rejects a bad manifest with the reader's reason and creates no installation artifacts",
  () =>
    Effect.gen(function* () {
      const { home, source, plugins } = yield* testProfile;
      yield* Effect.promise(() =>
        writeFile(join(source.locator, "plugin.json"), '{"$schema":"unknown","name":"sample"}'),
      );
      expect(yield* Effect.flip(plugins.install(source))).toMatchObject({
        code: "package-rejected",
        reasons: [{ code: "unsupported-version", path: "plugin.json", field: "$schema" }],
      });
      expect((yield* plugins.list).installations).toEqual([]);
      expect(yield* Effect.promise(() => readdir(home))).toEqual([]);
      expect(
        yield* Effect.flip(plugins.install({ kind: "git", locator: "https://example.com/plugin" })),
      ).toEqual({ code: "unsupported-source", kind: "git" });
    }).pipe(Effect.scoped),
);

it.effect("discards staging on a failed publish and leaves the old generation active", () =>
  Effect.gen(function* () {
    const { home, source, store, plugins } = yield* testProfile;
    const { installation } = yield* plugins.install(source);
    yield* plugins.setProjectEnabled(installation.id, project, true);
    yield* updateManifest(source.locator, { name: "sample.organizer", version: "2.0.0" });
    const contents = () => readdir(join(home, PLUGIN_REGISTRY_DIRECTORY));
    const before = yield* Effect.promise(contents);
    const failing = makePluginInstallation(
      reader,
      {
        ...store,
        compareAndSwap: () => Effect.fail({ code: "store-io", operation: "publish" }),
      },
      randomUUID,
    );
    expect(yield* Effect.flip(failing.reload(installation.id))).toEqual({
      code: "store-io",
      operation: "publish",
    });
    const [active] = yield* plugins.contributions(project);
    expect(active?.generation).toBe(installation.activeGeneration);
    expect(
      yield* Effect.promise(() =>
        readFile(join(home, active!.packageDirectory, "plugin.json"), "utf8"),
      ),
    ).toContain('"1.0.0"');
    expect((yield* Effect.promise(contents)).sort()).toEqual(before.sort());
  }).pipe(Effect.scoped),
);

it.effect("does not publish a staged copy with different bytes", () =>
  Effect.gen(function* () {
    const { source, store, plugins } = yield* testProfile;
    const tampered = makePluginInstallation(
      reader,
      {
        ...store,
        copyToStage: (locator, stage) =>
          store
            .copyToStage(locator, stage)
            .pipe(
              Effect.andThen(
                Effect.promise(() =>
                  writeFile(join(stage, "skills", "organize", "categories.txt"), "Changed"),
                ),
              ),
            ),
      },
      randomUUID,
    );
    expect(yield* Effect.flip(tampered.install(source))).toMatchObject({
      code: "staged-digest-mismatch",
    });
    expect((yield* plugins.list).installations).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "reinstalls in place, preserves activation, and reloads explicitly even when bytes match",
  () =>
    Effect.gen(function* () {
      const { home, source, plugins } = yield* testProfile;
      const { installation: first } = yield* plugins.install(source);
      yield* plugins.setProjectEnabled(first.id, project, true);
      yield* updateManifest(source.locator, { name: "sample.organizer", version: "2.0.0" });
      expect((yield* plugins.list).installations[0]?.activeGeneration).toBe(first.activeGeneration);
      const { installation: second } = yield* plugins.install(source);
      expect(second.id).toBe(first.id);
      expect(second.activeGeneration).not.toBe(first.activeGeneration);
      expect(second.package.identity.version).toBe("2.0.0");
      expect((yield* plugins.list).installations).toHaveLength(1);
      expect((yield* plugins.contributions(project))[0]?.generation).toBe(second.activeGeneration);
      expect(
        yield* Effect.promise(() =>
          stat(join(home, pluginPackageDirectory(first))).catch(
            (error: NodeJS.ErrnoException) => error.code,
          ),
        ),
      ).toBe("ENOENT");

      const { installation: reloaded } = yield* plugins.reload(first.id);
      expect(reloaded.package.digest).toBe(second.package.digest);
      expect(reloaded.activeGeneration).not.toBe(second.activeGeneration);
    }).pipe(Effect.scoped),
);

it.effect("refuses to reload when the source manifest changes identity", () =>
  Effect.gen(function* () {
    const { source, plugins } = yield* testProfile;
    const { installation } = yield* plugins.install(source);
    yield* updateManifest(source.locator, { name: "sample.renamed", version: "2.0.0" });
    expect(yield* Effect.flip(plugins.reload(installation.id))).toMatchObject({
      code: "identity-changed",
      id: installation.id,
    });
    expect((yield* plugins.list).installations).toEqual([installation]);
  }).pipe(Effect.scoped),
);

it.effect(
  "uninstalls the staged package and retains data by default until explicitly deleted",
  () =>
    Effect.gen(function* () {
      const { home, source, plugins } = yield* testProfile;
      const { installation } = yield* plugins.install(source);
      yield* plugins.setProjectEnabled(installation.id, project, true);
      const data = join(home, pluginDataDirectory(installation.id));
      yield* Effect.promise(async () => {
        await mkdir(data, { recursive: true });
        await writeFile(join(data, "saved.txt"), "keep");
      });
      expect((yield* plugins.uninstall(installation.id)).cleanupWarnings).toEqual([]);
      expect(yield* plugins.contributions(project)).toEqual([]);
      expect(yield* Effect.promise(() => readFile(join(data, "saved.txt"), "utf8"))).toBe("keep");
      const removed = yield* Effect.promise(() =>
        stat(join(home, pluginPackageDirectory(installation))).catch(
          (error: NodeJS.ErrnoException) => error.code,
        ),
      );
      expect(removed).toBe("ENOENT");

      yield* plugins.install(source);
      expect(
        (yield* plugins.uninstall(installation.id, { data: "delete" })).cleanupWarnings,
      ).toEqual([]);
      expect(
        yield* Effect.promise(() => stat(data).catch((error: NodeJS.ErrnoException) => error.code)),
      ).toBe("ENOENT");
    }).pipe(Effect.scoped),
);

it.effect("rejects a stale compare-and-swap across store instances", () =>
  Effect.gen(function* () {
    const { home, store, source, plugins } = yield* testProfile;
    const snapshot = yield* store.read;
    yield* plugins.install(source);
    const otherStore = makePluginInstallationStoreNode(home);
    expect(
      yield* Effect.flip(
        otherStore.compareAndSwap(snapshot.revision, {
          ...snapshot,
          revision: snapshot.revision + 1,
        }),
      ),
    ).toEqual({ code: "revision-conflict", expected: 0, actual: 1 });
    expect((yield* otherStore.read).installations).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "fails closed on malformed registry data and leaves the file available for recovery",
  () =>
    Effect.gen(function* () {
      const { home, source, plugins } = yield* testProfile;
      yield* plugins.install(source);
      const file = join(home, PLUGIN_REGISTRY_DIRECTORY, "registry.json");
      const corrupt = '{"format":1,"revision":1,"installations":[{"id":"../../outside"}]}';
      yield* Effect.promise(() => writeFile(file, corrupt));
      expect(yield* Effect.flip(plugins.contributions(project))).toEqual({
        code: "invalid-registry",
      });
      expect(yield* Effect.flip(plugins.install(source))).toEqual({ code: "invalid-registry" });
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe(corrupt);
    }).pipe(Effect.scoped),
);
