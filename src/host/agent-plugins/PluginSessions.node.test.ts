import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import {
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, vi } from "vitest";
import {
  DEFAULT_PLUGIN_MCP_LEASE_LIFETIME_MS,
  PluginMcpFailure,
  type PluginMcpBrokerService,
} from "./broker/contract";
import { makeFolderMarketplace } from "./FolderMarketplace";
import {
  ALL_PROJECTS,
  describeAgentSupport,
  pluginCatalogSnapshot,
  pluginReader,
  resolvePluginCache,
  type PluginCatalogSnapshot,
} from "./PluginCatalog";
import { makePluginSessions } from "./PluginSessions";
import type { PluginCatalogCache } from "./PluginCatalogCache";
import { makeSkillProjectionStore, SKILL_PROJECTION_IDLE_TTL } from "./SkillProjection";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, opendir: vi.fn(fs.opendir), rm: vi.fn(fs.rm) };
});

const withHome = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-plugins-"))),
  (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
);
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

const put = async (file: string, content: string) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
};
const fixture = async (root: string) => {
  await put(
    join(root, ".codex-plugin/plugin.json"),
    JSON.stringify({ name: "example", description: "Fixture" }),
  );
  await put(
    join(root, "skills/gauge/SKILL.md"),
    "---\nname: gauge\ndescription: Read a gauge.\nallowed-tools: Bash\nhooks: { PostToolUse: [] }\n---\nRead it.\n",
  );
  await put(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        gauge: { command: "node", args: ["server.mjs"] },
        public: { url: "https://example.com/mcp" },
        private: { url: "https://example.com/mcp", oauth_resource: "https://example.com" },
      },
    }),
  );
};

it.effect("uses the installed version, then the local or highest cached version", () =>
  Effect.gen(function* () {
    const home = yield* withHome;
    const plugin = join(home, "plugins/cache/nodex-local/example");
    yield* Effect.promise(() =>
      Promise.all(
        ["1.9.0", "1.12.0", "local"].map((v) => mkdir(join(plugin, v), { recursive: true })),
      ),
    );
    expect(yield* resolvePluginCache(home, "example@nodex-local", "1.9.0")).toContain("/1.9.0");
    expect(yield* resolvePluginCache(home, "example@nodex-local", "2.0.0")).toContain("/local");
    yield* Effect.promise(() => rm(join(plugin, "local"), { recursive: true }));
    expect(yield* resolvePluginCache(home, "example@nodex-local", null)).toContain("/1.12.0");
    expect(yield* resolvePluginCache(home, "../example@nodex-local", null)).toBeNull();
  }),
);

it.effect(
  "installs the reviewed bytes even when the source changes and discards staged copies",
  () =>
    Effect.gen(function* () {
      const home = yield* withHome;
      const root = join(home, "source");
      yield* Effect.promise(() => fixture(root));
      const market = yield* makeFolderMarketplace(home);
      const review = yield* market.prepare(root, new Set());
      if (review.status !== "ready") throw new Error(review.reasons.join(" "));
      expect(review.preview.mcpServers.find(({ key }) => key === "gauge")?.launch).toBe(
        "node server.mjs",
      );
      const file = join(root, "skills/gauge/SKILL.md");
      yield* Effect.promise(() => writeFile(file, "Source changed"));
      const native = (root: string, catalog: string, name: string) =>
        Effect.promise(async () => {
          expect(JSON.parse(await readFile(catalog, "utf8")).plugins[0].source.path).toBe(
            "./plugins/example",
          );
          expect(name).toBe("example");
          expect(
            await readFile(join(root, "plugins/example/skills/gauge/SKILL.md"), "utf8"),
          ).toContain("Read it.");
        });
      expect(yield* market.install(review.preview.stagingId, native)).toEqual({
        pluginId: "example@nodex-local",
        selector: { marketplacePath: market.catalogPath, pluginName: "example" },
      });
      expect((yield* market.sources).example).toContain("/source");
      yield* Effect.promise(() => fixture(root));
      const spare = yield* market.prepare(root, new Set(["example@nodex-local"]));
      if (spare.status !== "ready") throw new Error(spare.reasons.join(" "));
      expect(spare.preview.replacesPluginId).toBe("example@nodex-local");
      yield* market.discard(spare.preview.stagingId);
      expect(
        (yield* market.install(spare.preview.stagingId, native).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* Effect.promise(() => symlink(home, join(root, "escapes")));
      expect((yield* market.prepare(root, new Set())).status).toBe("rejected");
    }),
);

it.effect(
  "resolves Project and projectless scopes and revokes all leases on revision changes",
  () =>
    Effect.gen(function* () {
      const home = yield* withHome;
      const root = join(home, "source");
      yield* Effect.promise(() => fixture(root));
      const result = yield* pluginReader.read(root);
      if (result.status !== "loaded") throw new Error("Fixture did not load.");
      const pkg = result.package;
      expect(describeAgentSupport(pkg)).toEqual({
        outsideCodex: "partial",
        limitations: [{ kind: "mcp-server-needs-sign-in", serverKey: "private" }],
      });
      const opened: string[] = [];
      const revoked: string[] = [];
      const broker = {
        openLease: ({ serverKey }) =>
          Effect.sync(() => {
            opened.push(serverKey);
            return { id: serverKey, url: "http://localhost/lease", bearerToken: "token" };
          }),
        revokeLease: (id) =>
          Effect.sync(() => {
            revoked.push(id);
          }),
        openSkillCatalog: () => Effect.die("Unexpected ACP attachment"),
      } satisfies Pick<PluginMcpBrokerService, "openLease" | "openSkillCatalog" | "revokeLease">;
      let scope: import("../../shared/agent-plugins/session-plugins").PluginProjectScope = {
        kind: "projects",
        projectIds: ["project-a"],
      };
      let codexAvailable = false;
      const snapshot = () =>
        codexAvailable
          ? pluginCatalogSnapshot([{ id: "example@nodex-local", root, scope, package: pkg }])
          : null;
      const sessions = yield* makePluginSessions({
        home,
        skillProjections: yield* makeSkillProjectionStore(home),
        spaceId: "space",
        broker,
        catalog: {
          published: Stream.empty,
          latestRevision: () => snapshot()?.revision ?? null,
          read: () => Effect.sync(snapshot),
        },
      });
      const request = { threadId: "thread", projectId: null, backend: "claude" } as const;
      expect(yield* sessions.open("projectless", request)).toBeNull();
      const unavailableCodex = yield* sessions
        .open("codex", { ...request, backend: "codex" })
        .pipe(Effect.flip);
      expect(unavailableCodex._tag).toBe("PluginSessionPreparationError");
      expect(yield* sessions.revision("codex")).toBeNull();
      expect(opened).toHaveLength(0);
      codexAvailable = true;
      expect((yield* sessions.open("projectless", request))?.pluginIds).toEqual([]);
      const codex = yield* sessions.open("codex", { ...request, backend: "codex" });
      expect(codex?.codexDisabledPluginIds).toEqual(["example@nodex-local"]);
      const attached = yield* sessions.open("claude", { ...request, projectId: "project-a" });
      expect(opened.sort()).toEqual(["gauge", "public"]);
      expect(attached?.skills.map(({ alias }) => alias)).toEqual(["gauge"]);
      expect(yield* Effect.promise(() => readdir(attached!.skillsRoot!))).toEqual([
        ".claude-plugin",
        "skills",
      ]);
      const skill = yield* Effect.promise(() =>
        readFile(join(attached!.skillsRoot!, "skills/gauge/SKILL.md"), "utf8"),
      );
      expect(skill).not.toMatch(/allowed-tools|hooks/);
      scope = ALL_PROJECTS;
      expect(yield* sessions.revision("claude")).not.toBe(attached?.revision);
      expect(revoked.sort()).toEqual(["gauge", "public"]);
      expect((yield* sessions.open("projectless", request))?.pluginIds).toEqual([
        "example@nodex-local",
      ]);
      yield* sessions.close("projectless");
      expect(revoked).toHaveLength(4);
    }),
);

const claude = { threadId: "thread", projectId: "project-a", backend: "claude" } as const;
const unusedBroker = {
  openLease: () => Effect.die("Unexpected MCP attachment"),
  openSkillCatalog: () => Effect.die("Unexpected ACP attachment"),
  revokeLease: () => Effect.die("Unexpected MCP revocation"),
} satisfies Pick<PluginMcpBrokerService, "openLease" | "openSkillCatalog" | "revokeLease">;

it.effect("withdraws superseded leases before delivery and on publication", () =>
  Effect.gen(function* () {
    const home = yield* withHome;
    const root = join(home, "source");
    yield* Effect.promise(() => fixture(root));
    const result = yield* pluginReader.read(root);
    if (result.status !== "loaded") throw new Error("Fixture did not load.");
    const first = pluginCatalogSnapshot([
      { id: "example@local", root, scope: ALL_PROJECTS, package: result.package },
    ]);
    const second = pluginCatalogSnapshot([]);
    let snapshot: PluginCatalogSnapshot | null = null;
    const revoked = yield* Deferred.make<void>();
    const preparing = yield* Deferred.make<void>();
    const finishPreparing = yield* Deferred.make<void>();
    const revokedServers: string[] = [];
    const published = yield* PubSub.unbounded<Stream.Success<PluginCatalogCache["published"]>>();
    const sessions = yield* makePluginSessions({
      home,
      skillProjections: yield* makeSkillProjectionStore(home),
      spaceId: "space",
      catalog: {
        read: () => Effect.sync(() => snapshot),
        latestRevision: () => snapshot?.revision ?? null,
        published: Stream.fromPubSub(published),
      },
      broker: {
        ...unusedBroker,
        openLease: ({ serverKey, principal }) =>
          Effect.gen(function* () {
            if (principal.id === "opening" && serverKey === "public") {
              yield* Deferred.succeed(preparing, undefined);
              yield* Deferred.await(finishPreparing).pipe(Effect.interruptible);
            }
            return {
              id: principal.id + "/" + serverKey,
              url: "http://localhost/lease",
              bearerToken: "token",
            };
          }),
        revokeLease: (id) =>
          Effect.gen(function* () {
            revokedServers.push(id);
            if (revokedServers.length === 4) yield* Deferred.succeed(revoked, undefined);
          }),
      },
    });

    expect(yield* sessions.open("degraded", claude)).toBeNull();
    snapshot = first;
    const delivered = yield* sessions.open("delivered", claude);
    expect(delivered?.revision).toBe(first.revision);
    expect(yield* sessions.revision("degraded")).toBe(first.revision);

    snapshot = null;
    yield* PubSub.publish(published, { projectId: claude.projectId, revision: null });
    expect(yield* sessions.revision("delivered")).toBe(first.revision);
    expect(revokedServers).toEqual([]);

    snapshot = first;
    const opening = yield* sessions.open("opening", claude).pipe(Effect.forkScoped);
    yield* Deferred.await(preparing);

    // The new revision has loaded, but the publication has yet to be delivered.
    snapshot = second;
    yield* Deferred.succeed(finishPreparing, undefined);
    expect(yield* Fiber.join(opening)).toBeNull();
    expect(revokedServers.toSorted()).toEqual(["opening/gauge", "opening/public"]);
    expect(yield* sessions.revision("opening")).toBe(second.revision);

    yield* PubSub.publish(published, { projectId: claude.projectId, revision: second.revision });
    yield* Deferred.await(revoked);
    expect(revokedServers.toSorted()).toEqual([
      "delivered/gauge",
      "delivered/public",
      "opening/gauge",
      "opening/public",
    ]);
    expect(yield* sessions.revision("delivered")).toBeNull();
    expect(yield* sessions.revision("degraded")).toBe(second.revision);
  }),
);

it.effect("requests attachment renewal before broker expiry even if wall time moves backward", () =>
  Effect.gen(function* () {
    const home = yield* withHome;
    const snapshot = pluginCatalogSnapshot([]);
    const sessions = yield* makePluginSessions({
      home,
      skillProjections: yield* makeSkillProjectionStore(home),
      spaceId: "space",
      catalog: {
        read: () => Effect.succeed(snapshot),
        latestRevision: () => snapshot.revision,
        published: Stream.empty,
      },
      broker: unusedBroker,
    });

    expect((yield* sessions.open("aging", claude))?.revision).toBe(snapshot.revision);
    yield* TestClock.adjust(DEFAULT_PLUGIN_MCP_LEASE_LIFETIME_MS - 60_000 - 1);
    yield* TestClock.setTime(0);
    expect(yield* sessions.revision("aging")).toBe(snapshot.revision);
    yield* TestClock.adjust(1);
    expect(yield* sessions.revision("aging")).toBeNull();
  }),
);

it.effect("opens and closes another attachment while a Session's catalog read is pending", () =>
  Effect.gen(function* () {
    const home = yield* withHome;
    const reading = yield* Deferred.make<void>();
    const slow = yield* Deferred.make<PluginCatalogSnapshot>();
    const ready = pluginCatalogSnapshot([]);
    let slowRevision: string | null = null;
    const sessions = yield* makePluginSessions({
      home,
      skillProjections: yield* makeSkillProjectionStore(home),
      spaceId: "space",
      catalog: {
        published: Stream.empty,
        latestRevision: (projectId) =>
          projectId === claude.projectId ? slowRevision : ready.revision,
        read: (projectId) =>
          projectId === claude.projectId
            ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(slow)))
            : Effect.succeed(ready),
      },
      broker: unusedBroker,
    });

    const opening = yield* sessions.open("slow", claude).pipe(Effect.forkScoped);
    yield* Deferred.await(reading);
    const other = yield* sessions.open("other", { ...claude, projectId: "project-b" });
    expect(other?.revision).toBe(ready.revision);
    yield* sessions.close("other");
    expect(yield* sessions.revision("other")).toBeNull();
    expect(opening.pollUnsafe()).toBeUndefined();
    slowRevision = ready.revision;
    yield* Deferred.succeed(slow, ready);
    expect((yield* Fiber.join(opening))?.revision).toBe(ready.revision);
  }),
);

it.effect("shares a single in-flight projection across Projects and Runtime connections", () =>
  Effect.gen(function* () {
    const home = yield* withHome;
    const parent = join(home, "plugin-sessions");
    const root = join(home, "source");
    const extraRoot = join(home, "extra");
    yield* Effect.promise(async () => {
      await fixture(root);
      await fixture(extraRoot);
      await put(
        join(root, "skills/other/SKILL.md"),
        "---\nname: other\ndescription: Another skill.\n---\nRead it.\n",
      );
      await put(join(parent, "old-random/skills/old/SKILL.md"), "An old projection");
      await put(join(parent, ".tmp-leftover/partial"), "An unfinished projection");
    });
    const first = yield* pluginReader.read(root);
    const extra = yield* pluginReader.read(extraRoot);
    if (first.status !== "loaded" || extra.status !== "loaded")
      throw new Error("Fixtures did not load.");
    const plugin = {
      id: "example@local",
      root,
      scope: ALL_PROJECTS,
      package: { ...first.package, mcpServers: [] },
    };
    const extraPlugin = {
      id: "extra@local",
      root: extraRoot,
      scope: { kind: "projects", projectIds: ["project-c"] } as const,
      package: { ...extra.package, mcpServers: [] },
    };
    const snapshotA = pluginCatalogSnapshot([plugin, extraPlugin]);
    const snapshotB = pluginCatalogSnapshot([
      { ...plugin, package: { ...plugin.package, skills: plugin.package.skills.toReversed() } },
    ]);
    const skillProjections = yield* makeSkillProjectionStore(home);
    expect(yield* Effect.promise(() => readdir(parent))).toEqual([]);
    const catalogs: Parameters<PluginMcpBrokerService["openSkillCatalog"]>[0][] = [];
    const revoked: string[] = [];
    const broker = {
      ...unusedBroker,
      openSkillCatalog: (source) =>
        Effect.sync(() => {
          catalogs.push(source);
          const id = "catalog-" + catalogs.length;
          return { id, url: "http://localhost/lease", bearerToken: id };
        }),
      revokeLease: (id) =>
        Effect.sync(() => {
          revoked.push(id);
        }),
    } satisfies Pick<PluginMcpBrokerService, "openLease" | "openSkillCatalog" | "revokeLease">;
    const snapshotFor = (projectId: string | null) =>
      projectId === "project-b" ? snapshotB : snapshotA;
    const options = {
      home,
      skillProjections,
      spaceId: "space",
      broker,
      catalog: {
        read: (projectId: string | null) => Effect.succeed(snapshotFor(projectId)),
        latestRevision: (projectId: string | null) => snapshotFor(projectId).revision,
        published: Stream.empty,
      },
    };
    const sessions = yield* makePluginSessions(options);
    const secondConnection = yield* makePluginSessions(options);
    const requestB = { ...claude, backend: "acp", projectId: "project-b" };
    const canonicalRoot = yield* Effect.promise(() => realpath(root));
    const fs = yield* Effect.promise(() =>
      vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"),
    );
    const started = latch();
    const resume = latch();
    const removed = latch();
    let inventories = 0;
    let sharedRoot: string | null = null;
    vi.mocked(opendir).mockImplementation(async (path, options) => {
      if (path === canonicalRoot && ++inventories === 1) {
        started.resolve();
        await resume.promise;
      }
      return fs.opendir(path, options);
    });
    vi.mocked(rm).mockImplementation(async (path, options) => {
      await fs.rm(path, options);
      if (path === sharedRoot) removed.resolve();
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        resume.resolve();
        vi.mocked(opendir).mockReset();
        vi.mocked(rm).mockReset();
      }),
    );

    const opening = yield* sessions.open("first", claude).pipe(Effect.forkScoped);
    yield* Effect.promise(() => started.promise);
    const concurrent = yield* secondConnection
      .open("second", requestB)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    expect(concurrent.pollUnsafe()).toBeUndefined();
    expect(inventories).toBe(1);
    expect(yield* Effect.promise(() => readdir(parent))).toEqual([
      expect.stringMatching(/^\.tmp-/u),
    ]);
    resume.resolve();
    const attached = yield* Fiber.join(opening);
    const second = yield* Fiber.join(concurrent);
    if (!attached?.skillsRoot || !second) throw new Error("Sessions did not attach.");
    sharedRoot = attached.skillsRoot;
    expect(second.skillsRoot).toBe(sharedRoot);
    expect(second.skills).toEqual(attached.skills);
    expect(second.revision).not.toBe(attached.revision);
    expect(attached.skills.map(({ alias }) => alias)).toEqual(["gauge", "other"]);
    expect(inventories).toBe(1);

    yield* sessions.close("first");
    yield* TestClock.adjust(SKILL_PROJECTION_IDLE_TTL);
    expect(yield* Effect.promise(() => readdir(sharedRoot!))).toContain("skills");
    yield* secondConnection.close("second");
    const reused = yield* sessions.open("reused", requestB);
    expect(reused?.skillsRoot).toBe(sharedRoot);
    expect(second.skillCatalog?.bearerToken).toBe("catalog-1");
    expect(reused?.skillCatalog?.bearerToken).toBe("catalog-2");
    expect(catalogs.map((catalog) => catalog.map(([, source]) => source.packageRoot))).toEqual([
      [sharedRoot],
      [sharedRoot],
    ]);
    expect(inventories).toBe(1);
    yield* sessions.close("reused");
    expect(revoked).toEqual(["catalog-1", "catalog-2"]);
    yield* TestClock.adjust(SKILL_PROJECTION_IDLE_TTL);
    yield* Effect.promise(() => removed.promise);
    expect(yield* Effect.promise(() => readdir(parent))).toEqual([]);

    const other = yield* sessions.open("other", { ...claude, projectId: "project-c" });
    expect(other?.skillsRoot).toEqual(expect.any(String));
    expect(other?.skillsRoot).not.toBe(sharedRoot);
    expect(other?.skills.map(({ alias }) => alias)).toEqual([
      "gauge",
      "other",
      expect.stringMatching(/^gauge-[a-f0-9]{12}$/u),
    ]);
  }),
);

for (const failure of ["skills", "MCP"] as const) {
  it.effect(`leaves out only a plugin's ${failure} when they cannot be prepared`, () =>
    Effect.gen(function* () {
      const home = yield* withHome;
      const broken = join(home, "broken");
      const healthy = join(home, "healthy");
      const brokenSkill = join(broken, "skills/z-other/SKILL.md");
      yield* Effect.promise(async () => {
        await fixture(broken);
        await fixture(healthy);
        await put(brokenSkill, "---\nname: z-other\ndescription: Another skill.\n---\nRead it.\n");
      });
      const brokenResult = yield* pluginReader.read(broken);
      const healthyResult = yield* pluginReader.read(healthy);
      if (brokenResult.status !== "loaded" || healthyResult.status !== "loaded")
        throw new Error("Fixtures did not load.");
      if (failure === "skills") yield* Effect.promise(() => rm(brokenSkill));

      const snapshot = pluginCatalogSnapshot([
        { id: "broken@local", root: broken, scope: ALL_PROJECTS, package: brokenResult.package },
        {
          id: "healthy@local",
          root: healthy,
          scope: ALL_PROJECTS,
          package: healthyResult.package,
        },
      ]);
      const revoked: string[] = [];
      const sessions = yield* makePluginSessions({
        home,
        skillProjections: yield* makeSkillProjectionStore(home),
        spaceId: "space",
        catalog: {
          read: () => Effect.succeed(snapshot),
          latestRevision: () => snapshot.revision,
          published: Stream.empty,
        },
        broker: {
          ...unusedBroker,
          openLease: ({ pluginId, serverKey, principal }) =>
            failure === "MCP" &&
            principal.id === "attachment" &&
            pluginId === "broken@local" &&
            serverKey === "public"
              ? Effect.fail(new PluginMcpFailure("server_inactive"))
              : Effect.succeed({
                  id: pluginId + "/" + serverKey,
                  url: "http://localhost/lease",
                  bearerToken: "token",
                }),
          revokeLease: (id) =>
            Effect.sync(() => {
              revoked.push(id);
            }),
        },
      });

      const attached = yield* sessions.open("attachment", claude);
      const allSkills = ["gauge", "z-other", expect.stringMatching(/^gauge-[a-f0-9]{12}$/u)];
      expect(attached?.pluginIds).toEqual(["broken@local", "healthy@local"]);
      if (failure === "skills") {
        // The broken package's Skills are left out; its servers still reach the Session.
        expect(attached?.skills.map(({ alias }) => alias)).toEqual(["gauge"]);
        expect(yield* Effect.promise(() => readdir(join(attached!.skillsRoot!, "skills")))).toEqual(
          ["gauge"],
        );
        expect(attached?.mcpServers.map(({ pluginId }) => pluginId)).toEqual([
          "broken@local",
          "broken@local",
          "healthy@local",
          "healthy@local",
        ]);
        expect(revoked).toEqual([]);
      } else {
        // A server lease that fails leaves out that plugin's servers; its Skills stay.
        expect(attached?.skills.map(({ alias }) => alias)).toEqual(allSkills);
        expect(attached?.mcpServers.map(({ pluginId }) => pluginId)).toEqual([
          "healthy@local",
          "healthy@local",
        ]);
        expect(revoked).toEqual(["broken@local/gauge"]);
      }
      // Another Session with the same plugins shares the projection.
      const another = yield* sessions.open("another", claude);
      expect(another?.skillsRoot).toBe(attached?.skillsRoot);
      expect(another?.skills).toEqual(attached?.skills);
    }),
  );
}
