import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import type { PluginMcpBrokerService } from "./broker/contract";
import { makeFolderMarketplace } from "./FolderMarketplace";
import {
  ALL_PROJECTS,
  describeAgentSupport,
  pluginCatalogSnapshot,
  pluginReader,
  resolvePluginCache,
} from "./PluginCatalog";
import { makePluginSessions } from "./PluginSessions";

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
      const sessions = yield* makePluginSessions({
        home,
        spaceId: "space",
        changes: Stream.empty,
        broker,
        catalog: () =>
          Effect.sync(() =>
            pluginCatalogSnapshot([{ id: "example@nodex-local", root, scope, package: pkg }]),
          ),
      });
      const request = { threadId: "thread", projectId: null, backend: "claude" } as const;
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
