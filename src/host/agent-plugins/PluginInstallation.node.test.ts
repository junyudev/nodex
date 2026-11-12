import { CodexPluginDelivery } from "./CodexPluginDelivery";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  symlink,
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
import { testLayer as mainConfig } from "../../main/app/MainConfig";
import { makePluginInstallation, PluginInstallation } from "./PluginInstallation";
import { live as pluginInstallationLive } from "./PluginInstallationLive";
import { PluginMcpBroker } from "./broker";
import {
  materializeClaudePluginProjection,
  planClaudePluginProjection,
} from "./ClaudePluginProjection";
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

const previewDigest = Effect.fnUntraced(function* (locator: string) {
  const preview = yield* reader.read(locator);
  if (preview.status === "rejected") throw new Error("Expected a valid preview");
  return preview.package.digest;
});

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
    const { installation, cleanupWarnings } = yield* plugins.install(
      source,
      yield* previewDigest(source.locator),
    );
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
      expect(yield* Effect.flip(plugins.install(source, ""))).toMatchObject({
        code: "package-rejected",
        reasons: [{ code: "unsupported-version", path: "plugin.json", field: "$schema" }],
      });
      expect((yield* plugins.list).installations).toEqual([]);
      expect(yield* Effect.promise(() => readdir(home))).toEqual([]);
      expect(
        yield* Effect.flip(
          plugins.install({ kind: "git", locator: "https://example.com/plugin" }, ""),
        ),
      ).toEqual({ code: "unsupported-source", kind: "git" });
    }).pipe(Effect.scoped),
);

it.effect("discards staging on a failed publish and leaves the old generation active", () =>
  Effect.gen(function* () {
    const { home, source, store, plugins } = yield* testProfile;
    const { installation } = yield* plugins.install(source, yield* previewDigest(source.locator));
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

it.effect("rejects bytes changed since the confirmed preview", () =>
  Effect.gen(function* () {
    const { source, plugins } = yield* testProfile;
    const expected = yield* previewDigest(source.locator);
    yield* updateManifest(source.locator, { name: "sample.organizer", version: "2.0.0" });
    const actual = yield* previewDigest(source.locator);
    expect(actual).not.toBe(expected);
    expect(yield* Effect.flip(plugins.install(source, expected))).toEqual({
      code: "staged-digest-mismatch",
      expected,
      actual,
    });
    expect((yield* plugins.list).installations).toEqual([]);
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
    expect(
      yield* Effect.flip(tampered.install(source, yield* previewDigest(source.locator))),
    ).toMatchObject({
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
      const { installation: first } = yield* plugins.install(
        source,
        yield* previewDigest(source.locator),
      );
      yield* plugins.setProjectEnabled(first.id, project, true);
      yield* updateManifest(source.locator, { name: "sample.organizer", version: "2.0.0" });
      expect((yield* plugins.list).installations[0]?.activeGeneration).toBe(first.activeGeneration);
      const { installation: second } = yield* plugins.install(
        source,
        yield* previewDigest(source.locator),
      );
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
    const { installation } = yield* plugins.install(source, yield* previewDigest(source.locator));
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
      const { installation } = yield* plugins.install(source, yield* previewDigest(source.locator));
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

      yield* plugins.install(source, yield* previewDigest(source.locator));
      expect(
        (yield* plugins.uninstall(installation.id, { data: "delete" })).cleanupWarnings,
      ).toEqual([]);
      expect(
        yield* Effect.promise(() => stat(data).catch((error: NodeJS.ErrnoException) => error.code)),
      ).toBe("ENOENT");
    }).pipe(Effect.scoped),
);

it.live("reclaims a dead writer without disturbing a live owner", () =>
  Effect.gen(function* () {
    const { home, source, plugins } = yield* testProfile;
    const digest = yield* previewDigest(source.locator);
    const lock = join(home, PLUGIN_REGISTRY_DIRECTORY, ".writer");
    const liveOwner = join(lock, process.pid + "-" + randomUUID());
    yield* Effect.promise(async () => {
      await mkdir(lock, { recursive: true });
      await writeFile(liveOwner, "");
    });
    expect(yield* plugins.writerStatus).toBe("busy");
    expect(yield* Effect.flip(plugins.repairWriter)).toEqual({ code: "store-busy" });
    expect(yield* Effect.flip(plugins.install(source, digest))).toEqual({ code: "store-busy" });
    const { stdout } = yield* Effect.promise(() =>
      promisify(execFile)(process.execPath, ["-p", "process.pid"]),
    );
    yield* Effect.promise(async () => {
      await rm(liveOwner);
      await writeFile(join(lock, stdout.trim() + "-" + randomUUID()), "");
    });
    expect(yield* plugins.writerStatus).toBe("stale");
    yield* plugins.repairWriter;
    expect(yield* plugins.writerStatus).toBe("clear");

    // A later interrupted write is still reclaimed on the next mutation.
    yield* Effect.promise(async () => {
      await mkdir(lock);
      await writeFile(join(lock, stdout.trim() + "-" + randomUUID()), "");
    });
    const { installation } = yield* plugins.install(source, digest);
    expect((yield* plugins.list).installations).toEqual([installation]);
  }),
);

it.effect("rejects a stale compare-and-swap across store instances", () =>
  Effect.gen(function* () {
    const { home, store, source, plugins } = yield* testProfile;
    const snapshot = yield* store.read;
    yield* plugins.install(source, yield* previewDigest(source.locator));
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
      yield* plugins.install(source, yield* previewDigest(source.locator));
      const file = join(home, PLUGIN_REGISTRY_DIRECTORY, "registry.json");
      const corrupt = '{"format":1,"revision":1,"installations":[{"id":"../../outside"}]}';
      yield* Effect.promise(() => writeFile(file, corrupt));
      expect(yield* Effect.flip(plugins.contributions(project))).toEqual({
        code: "invalid-registry",
      });
      expect(
        yield* Effect.flip(plugins.install(source, yield* previewDigest(source.locator))),
      ).toEqual({ code: "invalid-registry" });
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe(corrupt);
    }).pipe(Effect.scoped),
);

it.live("revokes an open broker lease when the installation service disables it", () =>
  Effect.gen(function* () {
    const { home, source } = yield* testProfile;
    const digest = yield* previewDigest(source.locator);
    yield* Effect.gen(function* () {
      const plugins = yield* PluginInstallation;
      const broker = yield* PluginMcpBroker;
      const { installation } = yield* plugins.install(source, digest);
      yield* plugins.setProjectEnabled(installation.id, project, true);
      const scope = {
        installationId: installation.id,
        generation: installation.activeGeneration,
        serverKey: "catalog",
        project,
        principal: { kind: "agent-session", id: "session" },
      } as const;
      const lease = yield* broker.openLease(scope);

      yield* plugins.setEnabled(installation.id, false);

      expect(yield* Effect.flip(broker.listTools(scope, lease))).toMatchObject({
        code: "lease_revoked",
      });
      expect(yield* Effect.flip(broker.openLease(scope))).toMatchObject({
        code: "server_inactive",
      });
    }).pipe(
      Effect.provide(pluginInstallationLive.pipe(Layer.provide(mainConfig({ nodexHome: home })))),
    );
  }),
);

it.live("projects only active skills and withdraws replaced generations and their leases", () =>
  Effect.gen(function* () {
    const { home, source } = yield* testProfile;
    const digest = yield* previewDigest(source.locator);
    yield* Effect.gen(function* () {
      const plugins = yield* PluginInstallation;
      const delivery = yield* CodexPluginDelivery;
      const { installation } = yield* plugins.install(source, digest);
      expect(yield* delivery.status(project, true)).toBeNull();
      yield* plugins.setProjectEnabled(installation.id, project, true);

      const attach = Effect.gen(function* () {
        const revision = yield* delivery.status(project, true);
        if (!revision) return yield* Effect.die("Expected a delivery revision");
        const prepared = yield* delivery.attach(project, "session", "thread", revision);
        if (!prepared?.root || !prepared.servers[0])
          return yield* Effect.die("Expected a skill and MCP lease");
        return { revision, root: prepared.root, server: prepared.servers[0] };
      });
      const first = yield* attach;
      expect(yield* Effect.promise(() => readdir(first.root))).toEqual(["skills"]);
      const skills = yield* Effect.promise(() =>
        readdir(join(first.root, "skills"), { recursive: true }),
      );
      expect(skills.filter((file) => file.endsWith("SKILL.md"))).toEqual([
        join(installation.id + "-0", "organize", "SKILL.md"),
      ]);
      expect(skills.some((file) => file.endsWith("categories.txt"))).toBe(true);
      expect(yield* delivery.status({ ...project, projectId: "other-project" }, true)).toBeNull();

      yield* updateManifest(source.locator, { name: "sample.organizer", version: "2.0.0" });
      yield* plugins.reload(installation.id);
      const second = yield* attach;
      expect(second.root).not.toBe(first.root);
      expect(second.revision).not.toBe(first.revision);
      const withdrawn = (root: string, server: typeof first.server) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.promise(() =>
              stat(root).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
          const response = yield* Effect.promise(() =>
            fetch(server.url, {
              method: "POST",
              headers: { Authorization: server.authorization },
            }),
          );
          expect(response.status).toBe(401);
          yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
        });
      yield* withdrawn(first.root, first.server);

      yield* delivery.status(project, false);
      yield* withdrawn(second.root, second.server);
      const reactivated = yield* attach;
      expect(reactivated.revision).not.toBe(second.revision);
      yield* plugins.setEnabled(installation.id, false);
      yield* withdrawn(reactivated.root, reactivated.server);
      expect(yield* delivery.status(project, true)).toBeNull();

      yield* plugins.setEnabled(installation.id, true);
      const reenabled = yield* attach;
      yield* plugins.uninstall(installation.id);
      yield* withdrawn(reenabled.root, reenabled.server);
      expect(yield* delivery.status(project, true)).toBeNull();
    }).pipe(
      Effect.provide(pluginInstallationLive.pipe(Layer.provide(mainConfig({ nodexHome: home })))),
    );
  }),
);
it.effect("projects only activated skills and their current generation for Claude", () =>
  Effect.gen(function* () {
    const { home, source, plugins } = yield* testProfile;
    const sourceSkill = join(source.locator, "skills", "organize", "SKILL.md");
    const updateSkill = (nonce: string) =>
      Effect.promise(() =>
        writeFile(
          sourceSkill,
          [
            "---",
            "name: organize",
            "description: Organize a fixture.",
            "hooks: { SessionStart: [] }",
            "allowed-tools: Bash",
            "disable-model-invocation: true",
            "---",
            nonce,
          ].join("\n"),
        ),
      );
    yield* updateSkill("FIRST-SKILL");
    yield* Effect.promise(async () => {
      await mkdir(join(source.locator, "hooks"));
      await writeFile(join(source.locator, "hooks", "hooks.json"), "{}");
      await writeFile(join(source.locator, "shared.txt"), "Shared supporting file");
      await symlink("../../shared.txt", join(source.locator, "skills", "organize", "shared.txt"));
    });
    const { installation } = yield* plugins.install(source, yield* previewDigest(source.locator));
    const readPlan = () =>
      Effect.map(plugins.list, (registry) => planClaudePluginProjection(registry, project));
    expect((yield* readPlan()).plugins).toEqual([]);
    yield* plugins.setProjectEnabled(installation.id, project, true);
    const plan = yield* readPlan();
    expect(
      planClaudePluginProjection(yield* plugins.list, { ...project, projectId: "other" }).plugins,
    ).toEqual([]);

    const otherProject = { ...project, projectId: "other" };
    yield* plugins.setProjectEnabled(installation.id, otherProject, true);
    expect(planClaudePluginProjection(yield* plugins.list, otherProject).key).not.toBe(plan.key);
    expect((yield* readPlan()).key).toBe(plan.key);

    const first = yield* materializeClaudePluginProjection(home, plan);
    const root = first.roots[0]!;
    const slug = plan.plugins[0]!.name;
    expect(slug).toMatch(/^nodex-[a-f0-9]+$/u);
    expect(first.skills[0]?.name).toBe(`${slug}:organize`);
    expect(yield* Effect.promise(() => readdir(root))).toEqual([".claude-plugin", "skills"]);
    expect(
      yield* Effect.promise(() => readFile(join(root, ".claude-plugin", "plugin.json"), "utf8")),
    ).toBe(JSON.stringify({ name: slug }));
    const readSkill = (root: string) =>
      Effect.promise(() => readFile(join(root, "skills", "organize", "SKILL.md"), "utf8"));
    const skill = yield* readSkill(root);
    expect(skill).toContain("FIRST-SKILL");
    expect(skill).toContain("disable-model-invocation: true");
    expect(skill).not.toMatch(/hooks:|allowed-tools:/u);
    expect(
      yield* Effect.promise(() =>
        readFile(join(root, "skills", "organize", "categories.txt"), "utf8"),
      ),
    ).toContain("Supplies");

    expect(
      yield* Effect.promise(() => readFile(join(root, "skills", "organize", "shared.txt"), "utf8")),
    ).toBe("Shared supporting file");

    yield* updateSkill("SECOND-SKILL");
    yield* plugins.reload(installation.id);
    const next = yield* readPlan();
    expect(next.key).not.toBe(plan.key);
    expect(next.plugins[0]?.name).toBe(slug);
    const second = yield* materializeClaudePluginProjection(home, next);
    expect(yield* readSkill(second.roots[0]!)).toContain("SECOND-SKILL");
    expect(yield* readSkill(root)).toContain("FIRST-SKILL");
    yield* plugins.setEnabled(installation.id, false);
    expect((yield* materializeClaudePluginProjection(home, yield* readPlan())).roots).toEqual([]);
  }).pipe(Effect.scoped),
);
