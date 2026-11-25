import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { cp, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PORTABLE_1_0_MANIFEST_SCHEMA,
  PORTABLE_1_0_MCP_SCHEMA,
} from "../../shared/agent-plugins/portable-1.0.0";
import {
  NODEX_PLUGIN_NAMESPACE,
  type AgentPluginReadResult,
} from "../../shared/agent-plugins/types";
import { makeAgentPluginReader } from "./AgentPluginReader";
import { PACKAGE_LIMITS } from "./PackageFiles";
import { packageFilesNode } from "./PackageFilesNode";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  makePluginCatalogCache,
  PLUGIN_CATALOG_LOAD_DEADLINE,
  type LoadedPluginCatalog,
  type PluginCatalogCache,
} from "./PluginCatalogCache";

describe("AgentPluginReader", () => {
  // Agent Plugins 1.0.0 Appendix A, in source order:
  // 1–3 minimal + fatal manifest cases; 4–5 unknown fields/namespaces; 6 containment tests;
  // 7 OpenAI namespace defaults; 8–9 fixed and absent components; 10–11 MCP document and variants;
  // 12 connection order deferred (variants retained); 13 remote URL/header table;
  // 14 runtime provisioning deferred; 15 executable token cases; 16 default cwd;
  // 17 cwd syntax and escapes (runtime PLUGIN_DATA check deferred); 18–20 runtime env/PATH deferred
  // (reserved config keys tested); 21 variable references remain literal for delivery;
  // 22 portable unknown components ignored; 23–25 mixed MCP and skill fixtures.
  const reader = makeAgentPluginReader(packageFilesNode);
  const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);
  const read = (directory: string) => reader.read(directory);
  const manifest = { $schema: PORTABLE_1_0_MANIFEST_SCHEMA, name: "example.plugin" };
  const mcp = (mcpServers: object) => ({ $schema: PORTABLE_1_0_MCP_SCHEMA, mcpServers });

  function loaded(result: AgentPluginReadResult) {
    if (result.status === "rejected") throw new Error(JSON.stringify(result.reasons));
    return result.package;
  }

  function workspace<A>(test: (root: string) => Effect.Effect<A>) {
    return Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-plugin-reader-"))),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ).pipe(Effect.flatMap(test), Effect.scoped);
  }

  async function put(root: string, relative: string, value: string | object) {
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  }

  const skill = (name: string, extras = "") =>
    "---\nname: " +
    name +
    "\ndescription: A short description.\n" +
    extras +
    "---\n\nDo the work.\n";

  it.effect("loads a minimal portable package with absent components", () =>
    Effect.gen(function* () {
      const pkg = loaded(yield* read(fixture("portable")));
      expect(pkg).toMatchObject({
        layout: "portable-1.0.0",
        identity: { name: "example.plugin" },
        skills: [],
        mcpServers: [],
        diagnostics: [],
      });
    }),
  );

  it.effect("loads Codex metadata, skills, HTTP auth, hosted apps and inert hooks", () =>
    Effect.gen(function* () {
      const pkg = loaded(yield* read(fixture("codex")));
      expect(pkg).toMatchObject({
        layout: "codex",
        vendorSource: "codex-manifest",
        presentation: {
          displayName: "Review Toolkit",
          logo: "assets/logo.txt",
          defaultPrompts: ["Review my document."],
          capabilities: ["Read"],
        },
        skills: [{ name: "review", valid: true }],
        mcpServers: [
          {
            key: "review",
            transport: {
              type: "streamable-http",
              url: "https://example.com/mcp",
              headers: { "X-Client": "example" },
            },
            vendorAuth: {
              declaration: { type: "oauth", vendorField: true },
              legacy: { oauth_resource: "https://example.com/review" },
            },
          },
        ],
        apps: [
          { kind: "openai-hosted", key: "documents", id: "connector_example", optional: true },
        ],
        hooks: [
          {
            source: { kind: "file", path: "hooks/hooks.json" },
            events: [{ name: "PostToolUse", commands: ["review-document --check"] }],
          },
        ],
        diagnostics: [],
      });
    }),
  );

  it.effect("reads Claude skills and MCP with their original variable references", () =>
    Effect.gen(function* () {
      const pkg = loaded(yield* read(fixture("claude")));
      expect(pkg).toMatchObject({
        layout: "claude",
        skills: [{ name: "summarize", valid: true }],
        mcpServers: [
          {
            key: "summary",
            transport: {
              type: "stdio",
              command: "node",
              args: ["${CLAUDE_PLUGIN_ROOT}/summary.js"],
              cwd: "./",
            },
            variables: [{ field: "args", name: "CLAUDE_PLUGIN_ROOT" }],
          },
        ],
        hooks: [],
        apps: [],
        diagnostics: [],
      });
    }),
  );

  it.effect(
    "keeps portable identity and components canonical and selects one whole vendor overlay",
    () =>
      workspace((root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => cp(fixture("codex"), root, { recursive: true }));
          yield* Effect.promise(() =>
            put(root, "plugin.json", { ...manifest, mcpServers: "./.mcp.json" }),
          );
          let pkg = loaded(yield* read(root));
          expect(pkg).toMatchObject({
            layout: "portable-1.0.0",
            identity: { name: "example.plugin" },
            vendorSource: "codex-manifest",
            skills: [{ name: "review", valid: true }],
            mcpServers: [],
            diagnostics: [{ code: "unknown-manifest-field", field: "mcpServers" }],
          });
          expect(pkg.presentation?.displayName).toBe("Review Toolkit");

          yield* Effect.promise(() =>
            put(root, "plugin.json", {
              ...manifest,
              extensions: { "com.openai": { interface: { displayName: "Portable" } } },
            }),
          );
          yield* Effect.promise(() =>
            put(root, "com.openai/hooks/hooks.json", { hooks: { SessionStart: [] } }),
          );
          pkg = loaded(yield* read(root));
          expect(pkg).toMatchObject({
            vendorSource: "openai-extension",
            presentation: { displayName: "Portable" },
            hooks: [
              {
                source: { path: "com.openai/hooks/hooks.json" },
                events: [{ name: "SessionStart" }],
              },
            ],
            apps: [],
            mcpServers: [],
            diagnostics: [],
          });
          expect(pkg.presentation?.logo).toBeUndefined();

          yield* Effect.promise(() =>
            put(root, "plugin.json", { ...manifest, extensions: { "com.openai": {} } }),
          );
          expect(loaded(yield* read(root)).presentation).toBeUndefined();
        }),
      ),
  );

  it.effect("preserves opaque namespaces and ignores non-object extensions with a diagnostic", () =>
    workspace((root) =>
      Effect.gen(function* () {
        const extensions = {
          "example.unknown": [false, { nested: 42 }],
          [NODEX_PLUGIN_NAMESPACE]: { future: true },
        };
        yield* Effect.promise(() => put(root, "plugin.json", { ...manifest, extensions }));
        expect(loaded(yield* read(root)).extensions).toEqual(extensions);
        yield* Effect.promise(() => put(root, "plugin.json", { ...manifest, extensions: [] }));
        expect(loaded(yield* read(root))).toMatchObject({
          extensions: {},
          diagnostics: [{ code: "invalid-extensions" }],
        });
      }),
    ),
  );

  const fatalCases = [
    ["non-object", "[]"],
    ["malformed JSON", "{"],
    ["missing schema", { name: "example" }],
    ["non-string schema", { ...manifest, $schema: false }],
    ["empty schema", { ...manifest, $schema: "" }],
    ["missing name", { $schema: manifest.$schema }],
    ["non-string name", { ...manifest, name: null }],
    ...[
      "",
      "x".repeat(65),
      "Upper",
      "bad/slash",
      "-start",
      "end.",
      "bad--hyphens",
      "bad..dots",
      "example\n",
    ].map((name) => ["invalid name " + JSON.stringify(name), { ...manifest, name }] as const),
    ...["version", "description", "homepage", "repository", "license", "author", "keywords"].map(
      (field) => ["wrong type for " + field, { ...manifest, [field]: 42 }] as const,
    ),
    ["unknown author field", { ...manifest, author: { extra: "value" } }],
    ["non-string author field", { ...manifest, author: { email: [] } }],
    ["non-string keyword", { ...manifest, keywords: ["ok", 42] }],
  ] as const;

  for (const [label, value] of fatalCases) {
    it.effect("rejects " + label + " in the canonical manifest", () =>
      workspace((root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => put(root, "plugin.json", value));
          expect(yield* read(root)).toMatchObject({
            status: "rejected",
            reasons: expect.arrayContaining([
              expect.objectContaining({ code: "invalid-manifest" }),
            ]),
          });
        }),
      ),
    );
  }

  it.effect("rejects an unsupported manifest schema even when a Codex manifest is present", () =>
    workspace((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => cp(fixture("codex"), root, { recursive: true }));
        yield* Effect.promise(() =>
          put(root, "plugin.json", {
            ...manifest,
            $schema: manifest.$schema.replace("1.0.0", "1.1.0"),
          }),
        );
        expect(yield* read(root)).toMatchObject({
          status: "rejected",
          reasons: [{ code: "unsupported-version", field: "$schema" }],
        });
      }),
    ),
  );

  it.effect("validates metadata by type and isolates invalid and nested skills", () =>
    workspace((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await put(root, "plugin.json", {
            ...manifest,
            version: "daily",
            homepage: "homepage",
            author: { email: "contact" },
            license: "private",
          });
          await put(root, "skills/valid/SKILL.md", skill("valid", 'metadata: {version: "1"}\n'));
          await put(root, "skills/invalid/SKILL.md", skill("other", "metadata: {version: 1}\n"));
          await put(root, "skills/container/deeper/SKILL.md", skill("deeper"));
        });
        const pkg = loaded(yield* read(root));
        expect(pkg.identity).toMatchObject({
          version: "daily",
          homepage: "homepage",
          author: { email: "contact" },
          license: "private",
        });
        expect(pkg.skills).toMatchObject([
          {
            directory: "skills/invalid",
            valid: false,
            diagnostics: [{ field: "metadata" }, { field: "name" }],
          },
          { directory: "skills/valid", name: "valid", valid: true, diagnostics: [] },
        ]);
      }),
    ),
  );

  it.effect(
    "retains valid transports and literal values while skipping individual invalid entries",
    () =>
      workspace((root) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await put(root, "plugin.json", manifest);
            await put(
              root,
              "mcp.json",
              mcp({
                stdio: {
                  type: "stdio",
                  command: "node",
                  args: ["../opaque", "${PLUGIN_ROOT}/server", "${OTHER}"],
                  env: { STATE: "${PLUGIN_DATA}" },
                  cwd: "${PLUGIN_DATA}/work",
                },
                http: {
                  type: "streamable-http",
                  url: "https://example.com/mcp",
                  headers: { "X-Name": "${PLUGIN_ROOT}" },
                },
                legacy: { type: "sse", url: "http://[::1]:1234/events" },
                unknown: { type: "websocket", url: "https://example.com/mcp" },
                draft: {
                  type: "streamable-http",
                  url: "https://example.com/mcp",
                  extensions: { "com.openai": { auth: {} } },
                },
                reserved: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "bad" } },
                multiToken: { type: "stdio", command: "node script.js" },
                relativeCwd: { type: "stdio", command: "node", cwd: "data" },
                dataEscape: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/../elsewhere" },
              }),
            );
          });
          const pkg = loaded(yield* read(root));
          expect(pkg.mcpServers.map(({ key, transport }) => [key, transport.type])).toEqual([
            ["stdio", "stdio"],
            ["http", "streamable-http"],
            ["legacy", "sse"],
          ]);
          expect(pkg.mcpServers[0]).toMatchObject({
            transport: {
              args: ["../opaque", "${PLUGIN_ROOT}/server", "${OTHER}"],
              cwd: "${PLUGIN_DATA}/work",
            },
            variables: [
              { field: "args", name: "PLUGIN_ROOT" },
              { field: "env", name: "PLUGIN_DATA" },
              { field: "cwd", name: "PLUGIN_DATA" },
            ],
          });
          expect(pkg.mcpServers[1]).toMatchObject({
            transport: { headers: { "X-Name": "${PLUGIN_ROOT}" } },
            variables: [],
          });
          expect(pkg.diagnostics.map((issue) => issue.server)).toEqual([
            "unknown",
            "draft",
            "reserved",
            "multiToken",
            "relativeCwd",
            "dataEscape",
          ]);
        }),
      ),
  );

  it.effect("rejects invalid remote URLs and headers per entry", () =>
    workspace((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await put(root, "plugin.json", manifest);
          await put(
            root,
            "mcp.json",
            mcp({
              loopback: { type: "streamable-http", url: "http://127.0.0.2/mcp" },
              insecure: { type: "streamable-http", url: "http://example.com/mcp" },
              credentials: { type: "streamable-http", url: "https://user@example.com/mcp" },
              fragment: { type: "sse", url: "https://example.com/mcp#" },
              duplicateHeader: {
                type: "sse",
                url: "https://example.com/mcp",
                headers: { "X-ID": "a", "x-id": "b" },
              },
              invalidHeader: {
                type: "sse",
                url: "https://example.com/mcp",
                headers: { "X-ID": "a\nb" },
              },
            }),
          );
        });
        const pkg = loaded(yield* read(root));
        expect(pkg.mcpServers.map(({ key }) => key)).toEqual(["loopback"]);
        expect(pkg.diagnostics.map((issue) => issue.server)).toEqual([
          "insecure",
          "credentials",
          "fragment",
          "duplicateHeader",
          "invalidHeader",
        ]);
      }),
    ),
  );

  it.effect(
    "disables malformed, mismatched and open-schema MCP documents independently of skills",
    () =>
      workspace((root) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await put(root, "plugin.json", manifest);
            await put(root, "skills/valid/SKILL.md", skill("valid"));
          });
          for (const [value, code] of [
            ["{", "invalid-component"],
            [
              { ...mcp({}), $schema: PORTABLE_1_0_MCP_SCHEMA.replace("1.0.0", "1.1.0") },
              "unsupported-version",
            ],
            [{ ...mcp({}), extra: true }, "invalid-component"],
            [{ $schema: PORTABLE_1_0_MCP_SCHEMA, mcpServers: [] }, "invalid-component"],
          ] as const) {
            yield* Effect.promise(() => put(root, "mcp.json", value));
            expect(loaded(yield* read(root))).toMatchObject({
              skills: [{ name: "valid", valid: true }],
              mcpServers: [],
              diagnostics: [{ code }],
            });
          }
          yield* Effect.promise(async () => {
            await rm(join(root, "mcp.json"));
            await mkdir(join(root, "mcp.json"));
          });
          expect(loaded(yield* read(root))).toMatchObject({
            skills: [{ name: "valid", valid: true }],
            mcpServers: [],
            diagnostics: [{ code: "invalid-component" }],
          });
        }),
      ),
  );

  it.effect("isolates path escapes and resolves in-package symlinks for skills and assets", () =>
    workspace((root) =>
      Effect.gen(function* () {
        const directory = join(root, "plugin");
        yield* Effect.promise(async () => {
          await put(root, "outside.txt", "External content");
          await put(directory, "plugin.json", {
            ...manifest,
            extensions: {
              "com.openai": {
                interface: {
                  logo: "./assets/alias.txt",
                  composerIcon: "../outside.txt",
                  logoDark: join(root, "outside.txt"),
                },
              },
            },
          });
          await put(directory, "assets/logo.txt", "Local content");
          await symlink("logo.txt", join(directory, "assets/alias.txt"));
          await put(directory, "skills/local/SKILL.md", skill("local"));
          await mkdir(join(directory, "skills/escaping"));
          await symlink("../../../outside.txt", join(directory, "skills/escaping/SKILL.md"));
          await symlink("..", join(directory, "outside"));
          await put(
            directory,
            "mcp.json",
            mcp({
              escaped: { type: "stdio", command: "./outside/outside.txt" },
              outsideCwd: { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}/outside" },
              absolute: { type: "stdio", command: join(root, "outside.txt") },
              traversal: { type: "stdio", command: "./assets/../outside/outside.txt" },
              bundled: {
                type: "stdio",
                command: "./assets/alias.txt",
                cwd: "${PLUGIN_ROOT}/assets",
              },
            }),
          );
        });
        const pkg = loaded(yield* read(directory));
        expect(pkg.presentation).toEqual({ logo: "assets/logo.txt" });
        expect(pkg.skills).toMatchObject([
          { name: "escaping", valid: false, diagnostics: [{ code: "unsafe-path" }] },
          { name: "local", valid: true },
        ]);
        expect(pkg.mcpServers.map(({ key }) => key)).toEqual(["bundled"]);
        expect(pkg.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "unsafe-path", field: "interface.composerIcon" }),
            expect.objectContaining({ code: "unsafe-path", field: "interface.logoDark" }),
            expect.objectContaining({ code: "unsafe-path", server: "escaped" }),
            expect.objectContaining({ code: "unsafe-path", server: "outsideCwd" }),
            expect.objectContaining({ code: "invalid-server", server: "absolute" }),
            expect.objectContaining({ code: "invalid-server", server: "traversal" }),
          ]),
        );
      }),
    ),
  );

  it.effect(
    "rejects an escaping canonical manifest and disables an escaping component location",
    () =>
      workspace((root) =>
        Effect.gen(function* () {
          const directory = join(root, "plugin");
          yield* Effect.promise(async () => {
            await put(root, "outside.json", manifest);
            await put(directory, ".codex-plugin/plugin.json", { name: "fallback" });
            await symlink("../outside.json", join(directory, "plugin.json"));
          });
          expect(yield* read(directory)).toMatchObject({
            status: "rejected",
            reasons: [{ code: "unsafe-path", path: "plugin.json" }],
          });
          yield* Effect.promise(async () => {
            await rm(join(directory, "plugin.json"));
            await put(directory, "plugin.json", manifest);
            await symlink("../outside.json", join(directory, "mcp.json"));
            await put(directory, "skills/local/SKILL.md", skill("local"));
          });
          expect(loaded(yield* read(directory))).toMatchObject({
            mcpServers: [],
            skills: [{ name: "local", valid: true }],
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: "unsafe-path", path: "mcp.json" }),
            ]),
          });
        }),
      ),
  );

  it.effect(
    "hashes package-relative paths and bytes independently of directory and creation order",
    () =>
      workspace((root) =>
        Effect.gen(function* () {
          const a = join(root, "first");
          const b = join(root, "second");
          yield* Effect.promise(async () => {
            await put(a, "plugin.json", manifest);
            await put(a, "z.txt", "end");
            await put(a, "a.txt", "start");
            await put(b, "a.txt", "start");
            await put(b, "z.txt", "end");
            await put(b, "plugin.json", manifest);
          });
          const first = loaded(yield* read(a)).digest;
          expect(first).toMatch(/^[a-f0-9]{64}$/);
          expect(loaded(yield* read(b)).digest).toBe(first);
          yield* Effect.promise(() => put(b, "z.txt", "End"));
          expect(loaded(yield* read(b)).digest).not.toBe(first);
        }),
      ),
  );

  it.effect("rejects a package whose files exceed the byte budget", () =>
    workspace((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await put(root, "plugin.json", manifest);
          await put(root, "large.bin", "");
          await truncate(join(root, "large.bin"), PACKAGE_LIMITS.fileBytes + 1);
        });
        expect(yield* read(root)).toMatchObject({
          status: "rejected",
          reasons: [{ code: "package-limit", path: "large.bin" }],
        });
      }),
    ),
  );
});

describe("PluginCatalogCache", () => {
  const wait = { maxWait: "5 seconds" } as const;
  const fresh = { maxWait: PLUGIN_CATALOG_LOAD_DEADLINE, freshOnly: true } as const;
  const loaded = (revision: string, isCurrent = Effect.succeed(true)): LoadedPluginCatalog => ({
    snapshot: { revision, entries: [] },
    isCurrent,
  });

  const harness = Effect.gen(function* () {
    const invalidations = yield* PubSub.unbounded<void>();
    const pending =
      yield* Queue.unbounded<Deferred.Deferred<LoadedPluginCatalog | null, unknown>>();
    const published = yield* Queue.unbounded<Stream.Success<PluginCatalogCache["published"]>>();
    let loadCount = 0;
    const catalog = yield* makePluginCatalogCache({
      load: Effect.fnUntraced(function* () {
        const response = yield* Deferred.make<LoadedPluginCatalog | null, unknown>();
        loadCount++;
        yield* Queue.offer(pending, response);
        return yield* Deferred.await(response);
      }),
      invalidations: Stream.fromPubSub(invalidations),
    });
    yield* catalog.published.pipe(
      Stream.runForEach((event) => Queue.offer(published, event)),
      Effect.forkScoped({ startImmediately: true }),
    );
    return {
      catalog,
      read: (options: Parameters<PluginCatalogCache["read"]>[1] = wait) =>
        catalog.read("project-a", options).pipe(Effect.forkScoped({ startImmediately: true })),
      invalidate: PubSub.publish(invalidations, undefined),
      nextLoad: Queue.take(pending),
      nextPublication: Queue.take(published),
      publicationCount: Queue.size(published),
      loadCount: () => loadCount,
    };
  });

  it.effect("bounds a cold read and publishes when the shared load eventually finishes", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const reading = yield* f.read();
      const pending = yield* f.nextLoad;
      yield* TestClock.adjust("4999 millis");
      expect(reading.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(reading)).toBeNull();

      const latest = loaded("first");
      yield* Deferred.succeed(pending, latest);
      expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: "first" });
      expect(yield* f.catalog.read("project-a", wait)).toBe(latest.snapshot);
      expect(f.loadCount()).toBe(1);
    }),
  );

  it.effect("shares one cold load even if one reader is interrupted", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const first = yield* f.read();
      const pending = yield* f.nextLoad;
      yield* Fiber.interrupt(first);
      const second = yield* f.read();
      const latest = loaded("first");
      yield* Deferred.succeed(pending, latest);
      expect(yield* Fiber.join(second)).toBe(latest.snapshot);
      expect(f.loadCount()).toBe(1);
    }),
  );

  it.effect(
    "reloads on invalidation and serves the last snapshot to a reader with a short wait",
    () =>
      Effect.gen(function* () {
        const f = yield* harness;
        const first = yield* f.read();
        const latest = loaded("first");
        yield* Deferred.succeed(yield* f.nextLoad, latest);
        yield* Fiber.join(first);
        yield* f.nextPublication;

        yield* f.invalidate;
        const pending = yield* f.nextLoad;
        const reading = yield* f.read();
        const authoritative = yield* f.read(fresh);
        yield* TestClock.adjust(wait.maxWait);
        expect(yield* Fiber.join(reading)).toBe(latest.snapshot);
        expect(authoritative.pollUnsafe()).toBeUndefined();

        const updated = loaded("second");
        yield* Deferred.succeed(pending, updated);
        expect(yield* Fiber.join(authoritative)).toBe(updated.snapshot);
        expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: "second" });
      }),
  );

  it.effect("coalesces invalidations during a load into one follow-up", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const reading = yield* f.read(fresh);
      const pending = yield* f.nextLoad;
      yield* f.invalidate;
      yield* f.invalidate;
      yield* f.invalidate;
      yield* Effect.yieldNow;
      yield* Deferred.succeed(pending, loaded("first"));
      const followUp = yield* f.nextLoad;
      expect(reading.pollUnsafe()).toBeUndefined();
      const latest = loaded("second");
      yield* Deferred.succeed(followUp, latest);
      expect(yield* Fiber.join(reading)).toBe(latest.snapshot);
      expect(f.loadCount()).toBe(2);
    }),
  );

  it.effect(
    "keeps the last snapshot after load failures and deadlines while leaving it stale",
    () =>
      Effect.gen(function* () {
        const f = yield* harness;
        const reading = yield* f.read();
        const latest = loaded("first");
        yield* Deferred.succeed(yield* f.nextLoad, latest);
        yield* Fiber.join(reading);
        yield* f.nextPublication;

        yield* f.invalidate;
        const failed = yield* f.nextLoad;
        const authoritative = yield* f.read(fresh);
        yield* Deferred.fail(failed, "Unavailable");
        expect(yield* Fiber.join(authoritative)).toBeNull();

        const stale = yield* f.read();
        yield* f.nextLoad;
        yield* TestClock.adjust(wait.maxWait);
        expect(yield* Fiber.join(stale)).toBe(latest.snapshot);

        yield* TestClock.adjust(PLUGIN_CATALOG_LOAD_DEADLINE);
        expect(yield* f.publicationCount).toBe(0);
        const retry = yield* f.read();
        const pending = yield* f.nextLoad;
        yield* TestClock.adjust(wait.maxWait);
        expect(yield* Fiber.join(retry)).toBe(latest.snapshot);
        const updated = loaded("second");
        yield* Deferred.succeed(pending, updated);
        expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: "second" });
        expect(f.loadCount()).toBe(4);
      }),
  );

  it.effect(
    "reloads replaced packages and publishes only revision changes, including unavailability",
    () =>
      Effect.gen(function* () {
        const f = yield* harness;
        const first = yield* f.read();
        let current = true;
        yield* Deferred.succeed(
          yield* f.nextLoad,
          loaded(
            "first",
            Effect.sync(() => current),
          ),
        );
        yield* Fiber.join(first);
        yield* f.nextPublication;

        current = false;
        const replaced = yield* f.read();
        const sameRevision = loaded("first");
        yield* Deferred.succeed(yield* f.nextLoad, sameRevision);
        expect(yield* Fiber.join(replaced)).toBe(sameRevision.snapshot);

        yield* f.invalidate;
        yield* Deferred.succeed(yield* f.nextLoad, null);
        expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: null });
        const recovered = yield* f.read();
        yield* Deferred.succeed(yield* f.nextLoad, sameRevision);
        expect(yield* Fiber.join(recovered)).toBe(sameRevision.snapshot);
        expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: "first" });
        expect(yield* f.publicationCount).toBe(0);
      }),
  );
});
