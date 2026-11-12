import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { PluginProject } from "../../shared/agent-plugins/installation-registry";
import type { PluginInstallationService } from "./PluginInstallation";
import {
  materializeClaudePluginProjection,
  planClaudePluginProjection,
} from "./ClaudePluginProjection";
import type { PluginMcpBrokerService } from "./broker/contract";

function claudeServerName(installationId: string, key: string) {
  const name = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 12);
  const suffix = createHash("sha256")
    .update(JSON.stringify([installationId, key]))
    .digest("hex")
    .slice(0, 16);
  return `nodex-${name || "tool"}-${suffix}`;
}

const leaseLifetimeMs = 8 * 60 * 60 * 1000;

/** One owner's queries, released on native query exit or when its Runtime disconnects. */
export const makeClaudePluginQueries = Effect.fn("ClaudePluginQueries.make")(function* (input: {
  readonly home: string;
  readonly installations: Pick<PluginInstallationService, "list">;
  readonly broker: Pick<PluginMcpBrokerService, "openLease" | "revokeLease">;
}) {
  const owner = yield* Effect.scope;
  const queries = new Map<string, Scope.Closeable>();
  const plan = (project: PluginProject) =>
    Effect.map(input.installations.list, (registry) =>
      planClaudePluginProjection(registry, project),
    );
  const close = (queryId: string) =>
    Effect.suspend(() => {
      const scope = queries.get(queryId);
      return scope ? Scope.close(scope, Exit.void) : Effect.void;
    });

  const open = Effect.fn("ClaudePluginQueries.open")(function* (
    project: PluginProject,
    sessionId: string,
    queryId: string,
    expectedKey: string,
  ) {
    const current = yield* plan(project);
    if (current.key !== expectedKey || queries.has(queryId))
      return yield* Effect.fail(new Error("The Claude plugin set changed before query launch."));
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(owner);
        queries.set(queryId, scope);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            queries.delete(queryId);
          }),
        );
        return yield* restore(
          Effect.gen(function* () {
            const projection = yield* materializeClaudePluginProjection(input.home, current);
            const startedAt = yield* Clock.currentTimeMillis;
            const servers = yield* Effect.forEach(
              current.plugins.flatMap((plugin) =>
                plugin.mcpServers.map((server) => ({ plugin, server })),
              ),
              Effect.fnUntraced(function* ({ plugin, server }) {
                const lease = yield* Effect.acquireRelease(
                  input.broker.openLease(
                    {
                      installationId: plugin.installationId,
                      generation: plugin.generation,
                      serverKey: server.key,
                      project,
                      principal: { kind: "agent-session", id: sessionId },
                    },
                    {
                      // Claude's existing native tool permission policy is the approval authority.
                      approval: () => Effect.succeed("allow" as const),
                      maxLifetimeMs: leaseLifetimeMs,
                    },
                  ),
                  (lease) => input.broker.revokeLease(lease.id),
                );
                return {
                  name: claudeServerName(plugin.installationId, server.key),
                  url: lease.url,
                  bearerToken: lease.bearerToken,
                };
              }),
            );
            if ((yield* plan(project)).key !== current.key)
              return yield* Effect.fail(
                new Error("The Claude plugin set changed during query launch."),
              );
            return {
              ...projection,
              identities: current.plugins.map(({ identity }) => identity),
              servers,
              renewAfter: servers.length === 0 ? null : startedAt + leaseLifetimeMs - 60_000,
            };
          }).pipe(Scope.provide(scope)),
        ).pipe(Effect.onError(() => close(queryId)));
      }),
    );
  });

  return { plan, open, close };
});
