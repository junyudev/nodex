import { compareExactSemanticVersions } from "../../shared/codex-app-server-version";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { PluginSummary } from "@nodex/codex-app-server-protocol/v2/PluginSummary";
import type {
  PluginAgentSupport,
  PluginProjectScope,
} from "../../shared/agent-plugins/session-plugins";
import type { AgentPluginMcpServer, AgentPluginPackage } from "../../shared/agent-plugins/types";
import { makeAgentPluginReader } from "./AgentPluginReader";
import { packageFilesNode } from "./PackageFilesNode";

export const pluginReader = makeAgentPluginReader(packageFilesNode);
export const ALL_PROJECTS = { kind: "all" } as const;
export const pluginRevision = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const includesProject = (scope: PluginProjectScope, projectId: string | null) =>
  scope.kind === "all" || (projectId !== null && scope.projectIds.includes(projectId));

export const runnableServer = ({ transport, vendorAuth }: AgentPluginMcpServer) =>
  transport.type === "stdio" ||
  (!vendorAuth &&
    !Object.keys(transport.headers).some((key) =>
      /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key)$/iu.test(key),
    ));

export function describeAgentSupport(pkg: AgentPluginPackage): PluginAgentSupport {
  const limitations: PluginAgentSupport["limitations"] = [
    ...pkg.mcpServers
      .filter((server) => !runnableServer(server))
      .map(({ key }) => ({
        kind: "mcp-server-needs-sign-in" as const,
        serverKey: key,
      })),
    ...pkg.apps.map(({ key }) => ({ kind: "connected-app" as const, name: key })),
    ...(pkg.hooks.length ? [{ kind: "hooks" as const }] : []),
  ];
  const available = pkg.skills.some(({ valid }) => valid) || pkg.mcpServers.some(runnableServer);
  return {
    outsideCodex: available ? (limitations.length ? "partial" : "full") : "none",
    limitations,
  };
}

export const pluginPathComponent = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value) && !/[.]$/u.test(value);

const compareVersion = (left: string, right: string) =>
  compareExactSemanticVersions(left, right) ?? (left < right ? -1 : left > right ? 1 : 0);

export function resolvePluginCache(home: string, id: string, version: string | null) {
  return Effect.tryPromise(async () => {
    const [name, marketplace, extra] = id.split("@");
    if (
      !name ||
      !marketplace ||
      extra !== undefined ||
      ![name, marketplace].every(pluginPathComponent)
    )
      return null;
    const root = await realpath(home);
    const directory = join(root, "plugins", "cache", marketplace, name);
    if ((await realpath(directory)) !== directory) return null;
    const versions = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && pluginPathComponent(entry.name))
      .map(({ name }) => name);
    const active =
      version && versions.includes(version)
        ? version
        : versions.includes("local")
          ? "local"
          : versions.sort(compareVersion).at(-1);
    if (!active) return null;
    const path = join(directory, active);
    return (await realpath(path)) === path ? path : null;
  }).pipe(Effect.orElseSucceed(() => null));
}

const readPackage = Effect.fn("PluginCatalog.readPackage")(function* (id: string, root: string) {
  const read = yield* pluginReader.read(root);
  return read.status === "loaded" && read.package.identity.name === id.split("@")[0]
    ? { root, package: read.package }
    : null;
});

export const readInstalledPlugin = Effect.fn("PluginCatalog.readInstalled")(function* (
  home: string,
  summary: PluginSummary,
) {
  if (!summary.installed) return null;
  const root = yield* resolvePluginCache(home, summary.id, summary.localVersion);
  return root ? yield* readPackage(summary.id, root) : null;
});

class PackageKey extends Data.Class<{
  readonly id: string;
  readonly root: string;
  readonly identity: string;
}> {}

const directoryIdentity = (root: string) =>
  Effect.tryPromise(() => lstat(root, { bigint: true })).pipe(
    Effect.map((stat) =>
      stat.isDirectory() ? `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}` : null,
    ),
    Effect.orElseSucceed(() => null),
  );

export const makeInstalledPluginCache = Effect.fn("PluginCatalog.makePackageCache")(function* (
  home: string,
) {
  const packages = yield* Cache.makeWith(
    Effect.fnUntraced(function* ({ id, root, identity }: PackageKey) {
      const installed = yield* readPackage(id, root);
      // Codex replaces the directory on reinstall, even when the version is still "local".
      return (yield* directoryIdentity(root)) === identity ? { installed } : null;
    }),
    {
      capacity: 512,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value ? Duration.infinity : Duration.zero,
    },
  );
  return Effect.fn("PluginCatalog.cachedPackage")(function* (summary: PluginSummary) {
    const root = yield* resolvePluginCache(home, summary.id, summary.localVersion);
    if (!root) return null;
    const identity = yield* directoryIdentity(root);
    if (!identity) return null;
    const cached = yield* Cache.get(packages, new PackageKey({ id: summary.id, root, identity }));
    return cached?.installed ?? null;
  });
});

export interface CatalogPlugin {
  readonly id: string;
  readonly scope: PluginProjectScope;
  readonly root: string | null;
  readonly package: AgentPluginPackage | null;
}

export interface PluginCatalogSnapshot {
  readonly entries: readonly CatalogPlugin[];
  readonly revision: string;
}

export function pluginCatalogSnapshot(entries: readonly CatalogPlugin[]): PluginCatalogSnapshot {
  return {
    entries,
    revision: pluginRevision(
      entries.map(({ id, scope, root, package: pkg }) => [id, scope, root, pkg?.digest]),
    ),
  };
}

export const readPluginCatalog = Effect.fn("PluginCatalog.read")(function* (
  summaries: readonly PluginSummary[],
  scopes: Readonly<Record<string, PluginProjectScope>>,
  readPackage: (summary: PluginSummary) => ReturnType<typeof readInstalledPlugin>,
) {
  return yield* Effect.forEach(
    [
      ...new Map(
        summaries
          .filter(({ installed, enabled }) => installed && enabled)
          .map((summary) => [summary.id, summary]),
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id)),
    Effect.fnUntraced(function* (summary): Effect.fn.Return<CatalogPlugin> {
      const installed = yield* readPackage(summary);
      return {
        id: summary.id,
        scope: Object.hasOwn(scopes, summary.id) ? scopes[summary.id]! : ALL_PROJECTS,
        root: installed?.root ?? null,
        package: installed?.package ?? null,
      };
    }),
    { concurrency: 4 },
  );
});
