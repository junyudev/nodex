import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { cp, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
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
  "---\nname: " + name + "\ndescription: A short description.\n" + extras + "---\n\nDo the work.\n";

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
      apps: [{ kind: "openai-hosted", key: "documents", id: "connector_example", optional: true }],
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
            { source: { path: "com.openai/hooks/hooks.json" }, events: [{ name: "SessionStart" }] },
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
          reasons: expect.arrayContaining([expect.objectContaining({ code: "invalid-manifest" })]),
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
            bundled: { type: "stdio", command: "./assets/alias.txt", cwd: "${PLUGIN_ROOT}/assets" },
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
