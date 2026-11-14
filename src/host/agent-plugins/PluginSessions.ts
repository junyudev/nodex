import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type {
  SessionPlugins,
  SessionPluginsRequest,
} from "../../shared/agent-plugins/session-plugins";
import type { PluginMcpBrokerService } from "./broker/contract";
import {
  includesProject,
  pluginRevision,
  runnableServer,
  type PluginCatalogSnapshot,
} from "./PluginCatalog";
import { projectSkills } from "./SkillProjection";

const lifetime = 8 * 60 * 60 * 1000;

export const makePluginSessions = Effect.fn("PluginSessions.make")(function* (input: {
  readonly home: string;
  readonly spaceId: string;
  readonly catalog: (projectId: string | null) => Effect.Effect<PluginCatalogSnapshot, unknown>;
  readonly changes: Stream.Stream<unknown>;
  readonly broker: Pick<PluginMcpBrokerService, "openLease" | "openSkillCatalog" | "revokeLease">;
}) {
  const owner = yield* Effect.scope;
  const gate = yield* Semaphore.make(1);
  const attachments = new Map<
    string,
    {
      projectId: string | null;
      scope: Scope.Closeable;
      revision: string;
      expiresAt: number;
    }
  >();
  const release = (id: string) =>
    Effect.suspend(() => {
      const attachment = attachments.get(id);
      attachments.delete(id);
      return attachment ? Scope.close(attachment.scope, Exit.void) : Effect.void;
    });
  const revision = (id: string) =>
    gate.withPermit(
      Effect.gen(function* () {
        const attachment = attachments.get(id);
        if (!attachment) return null;
        const { revision: next } = yield* input
          .catalog(attachment.projectId)
          .pipe(Effect.onError(() => release(id)));
        const now = yield* Clock.currentTimeMillis;
        if (next === attachment.revision && now < attachment.expiresAt) return next;
        yield* release(id);
        return next === attachment.revision ? null : next;
      }),
    );
  yield* input.changes.pipe(
    Stream.runForEach(() =>
      Effect.suspend(() =>
        Effect.forEach([...attachments.keys()], (id) => revision(id).pipe(Effect.ignore), {
          discard: true,
        }),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const open = (id: string, request: SessionPluginsRequest) =>
    gate.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (request.backend === "opencode") return null;
          yield* release(id);
          const { projectId } = request;
          const { revision, entries } = yield* restore(input.catalog(projectId));
          const base = {
            revision,
            skillsRoot: null,
            skills: [],
            mcpServers: [],
            pluginIds: [],
            codexDisabledPluginIds: [],
          };
          if (request.backend === "codex")
            return {
              ...base,
              codexDisabledPluginIds: entries
                .filter(({ scope }) => !includesProject(scope, projectId))
                .map(({ id }) => id),
            };
          const eligible = entries.filter(({ scope }) => includesProject(scope, projectId));
          const scope = yield* Scope.fork(owner);
          const now = yield* Clock.currentTimeMillis;
          attachments.set(id, { projectId, scope, revision, expiresAt: now + lifetime - 60_000 });
          return yield* restore(
            Effect.gen(function* (): Effect.fn.Return<SessionPlugins, unknown, Scope.Scope> {
              const projection = yield* projectSkills(input.home, revision, eligible);
              const project = { spaceId: input.spaceId, projectId: request.projectId ?? "" };
              const mcpServers = yield* Effect.forEach(
                request.backend === "acp" && !request.acpHttp ? [] : eligible,
                Effect.fnUntraced(function* (plugin) {
                  if (!plugin.root || !plugin.package) return [];
                  const installation = {
                    packageRoot: plugin.root,
                    dataRoot: join(input.home, "plugin-data", pluginRevision(plugin.id)),
                    generation: plugin.package.digest,
                    servers: plugin.package.mcpServers.filter(runnableServer),
                  };
                  return yield* Effect.forEach(
                    installation.servers,
                    Effect.fnUntraced(function* (server) {
                      const lease = yield* Effect.acquireRelease(
                        input.broker.openLease(
                          {
                            pluginId: plugin.id,
                            generation: installation.generation,
                            serverKey: server.key,
                            project,
                            principal: { kind: "agent-session", id },
                          },
                          installation,
                          { approval: () => Effect.succeed("allow"), httpBinding: "mcp-session" },
                        ),
                        (lease) => input.broker.revokeLease(lease.id),
                      );
                      const suffix = pluginRevision([plugin.id, server.key]).slice(0, 16);
                      const label = server.key
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/gu, "-")
                        .slice(0, 20);
                      return {
                        pluginId: plugin.id,
                        serverKey: server.key,
                        name: `nodex-${label}-${suffix}`,
                        url: lease.url,
                        bearerToken: lease.bearerToken,
                      };
                    }),
                  );
                }),
              );
              const skillsRoot = projection.skillsRoot;
              const catalogEntries = skillsRoot
                ? eligible.flatMap(({ id }) => {
                    const skills = projection.skills.filter((skill) => skill.pluginId === id);
                    if (!skills.length) return [];
                    return [
                      [
                        id,
                        {
                          packageRoot: skillsRoot,
                          servers: [],
                          generation: revision,
                          dataRoot: "",
                          skills: skills.map(({ alias, description }) => ({
                            name: alias,
                            directory: "skills/" + alias,
                            description,
                            valid: true,
                            diagnostics: [],
                          })),
                        },
                      ] as const,
                    ];
                  })
                : [];
              const skillCatalog =
                request.backend === "acp" && catalogEntries.length
                  ? yield* Effect.acquireRelease(
                      input.broker.openSkillCatalog(catalogEntries),
                      (lease) => input.broker.revokeLease(lease.id),
                    )
                  : null;
              return {
                ...base,
                ...projection,
                mcpServers: mcpServers.flat(),
                pluginIds: eligible
                  .filter(
                    ({ package: pkg }) =>
                      pkg &&
                      (pkg.skills.some(({ valid }) => valid) ||
                        pkg.mcpServers.some(runnableServer)),
                  )
                  .map(({ id }) => id),
                ...(skillCatalog
                  ? {
                      skillCatalog: {
                        name: "nodex_plugin_skills",
                        url: skillCatalog.url,
                        bearerToken: skillCatalog.bearerToken,
                      },
                    }
                  : {}),
              };
            }).pipe(
              Scope.provide(scope),
              Effect.onError(() => release(id)),
            ),
          );
        }),
      ),
    );
  return { open, revision, close: (id: string) => gate.withPermit(release(id)) };
});
