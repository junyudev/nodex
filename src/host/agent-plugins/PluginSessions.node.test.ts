import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { PluginMcpFailure, type PluginMcpBrokerService } from "./broker/contract";
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

const withHome = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-plugins-"))),
  (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
);
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
      const sessions = yield* makePluginSessions({
        home,
        spaceId: "space",
        broker,
        catalog: {
          published: Stream.empty,
          read: () =>
            Effect.sync(() =>
              codexAvailable
                ? pluginCatalogSnapshot([{ id: "example@nodex-local", root, scope, package: pkg }])
                : null,
            ),
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

it.effect("retains degraded attachments and revokes delivered leases on publication", () =>
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
    const revokedServers: string[] = [];
    const published = yield* PubSub.unbounded<Stream.Success<PluginCatalogCache["published"]>>();
    const sessions = yield* makePluginSessions({
      home,
      spaceId: "space",
      catalog: { read: () => Effect.sync(() => snapshot), published: Stream.fromPubSub(published) },
      broker: {
        ...unusedBroker,
        openLease: ({ serverKey }) =>
          Effect.succeed({ id: serverKey, url: "http://localhost/lease", bearerToken: "token" }),
        revokeLease: (id) =>
          Effect.gen(function* () {
            revokedServers.push(id);
            if (revokedServers.length === 2) yield* Deferred.succeed(revoked, undefined);
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

    snapshot = second;
    yield* PubSub.publish(published, { projectId: claude.projectId, revision: second.revision });
    yield* Deferred.await(revoked);
    expect(revokedServers.toSorted()).toEqual(["gauge", "public"]);
    expect(yield* sessions.revision("delivered")).toBeNull();
    expect(yield* sessions.revision("degraded")).toBe(second.revision);
  }),
);

it.effect("opens and closes another attachment while a Session's catalog read is pending", () =>
  Effect.gen(function* () {
    const home = yield* withHome;
    const reading = yield* Deferred.make<void>();
    const slow = yield* Deferred.make<PluginCatalogSnapshot>();
    const ready = pluginCatalogSnapshot([]);
    const sessions = yield* makePluginSessions({
      home,
      spaceId: "space",
      catalog: {
        published: Stream.empty,
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
    yield* Deferred.succeed(slow, ready);
    expect((yield* Fiber.join(opening))?.revision).toBe(ready.revision);
  }),
);

for (const failure of ["skills", "MCP"] as const) {
  it.effect(
    `skips the plugin whose ${failure} preparation fails and cleans up its partial output`,
    () =>
      Effect.gen(function* () {
        const home = yield* withHome;
        const broken = join(home, "broken");
        const healthy = join(home, "healthy");
        const brokenSkill = join(broken, "skills/z-other/SKILL.md");
        yield* Effect.promise(async () => {
          await fixture(broken);
          await fixture(healthy);
          await put(
            brokenSkill,
            "---\nname: z-other\ndescription: Another skill.\n---\nRead it.\n",
          );
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
          spaceId: "space",
          catalog: { read: () => Effect.succeed(snapshot), published: Stream.empty },
          broker: {
            ...unusedBroker,
            openLease: ({ pluginId, serverKey }) =>
              failure === "MCP" && pluginId === "broken@local" && serverKey === "public"
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
        expect(attached?.pluginIds).toEqual(["healthy@local"]);
        expect(attached?.skills.map(({ alias }) => alias)).toEqual(["gauge"]);
        expect(attached?.mcpServers.map(({ pluginId }) => pluginId)).toEqual([
          "healthy@local",
          "healthy@local",
        ]);
        expect(yield* Effect.promise(() => readdir(join(attached!.skillsRoot!, "skills")))).toEqual(
          ["gauge"],
        );
        expect(revoked).toEqual(failure === "MCP" ? ["broken@local/gauge"] : []);
      }),
  );
}
