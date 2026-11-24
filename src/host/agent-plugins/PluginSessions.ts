import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as RcMap from "effect/RcMap";
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
  type CatalogPlugin,
  type PluginCatalogSnapshot,
} from "./PluginCatalog";
import { makeSkillProjection } from "./SkillProjection";
import { PluginSessionPreparationError } from "./PluginSessionPreparationError";
import type { PluginCatalogCache } from "./PluginCatalogCache";

const lifetime = 8 * 60 * 60 * 1000;
// A reply waits briefly for a reread in progress, then starts with the plugins already read.
const replyCatalogWait = { maxWait: "5 seconds" } as const;
// A Codex thread needs current out-of-scope overrides; answer within the Runtime's 30 s deadline.
const codexCatalogWait = { maxWait: "20 seconds", freshOnly: true } as const;

type Attachment = { projectId: string | null } & (
  | { revision: null }
  | { revision: string; scope: Scope.Closeable; expiresAt: number }
);

export const makePluginSessions = Effect.fn("PluginSessions.make")(function* (input: {
  readonly home: string;
  readonly spaceId: string;
  readonly catalog: PluginCatalogCache;
  readonly broker: Pick<PluginMcpBrokerService, "openLease" | "openSkillCatalog" | "revokeLease">;
}) {
  const owner = yield* Effect.scope;
  const lanes = yield* RcMap.make({ lookup: (_id: string) => Semaphore.make(1) });
  const attachments = new Map<string, Attachment>();
  const publishedRevisions = new Map<string | null, string | null>();

  const serial = <A, E>(id: string, operation: Effect.Effect<A, E>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lane = yield* RcMap.get(lanes, id);
        return yield* lane.withPermit(operation);
      }),
    );
  const release = (id: string) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        const attachment = attachments.get(id);
        attachments.delete(id);
        return attachment && attachment.revision !== null
          ? Scope.close(attachment.scope, Exit.void)
          : Effect.void;
      }),
    );
  const revision = (id: string) =>
    serial(
      id,
      Effect.gen(function* () {
        const attachment = attachments.get(id);
        if (!attachment) return null;
        const current = yield* input.catalog.read(attachment.projectId, replyCatalogWait);
        if (!current) return attachment.revision;
        const next = current.revision;
        if (attachment.revision === null) return next;
        const now = yield* Clock.currentTimeMillis;
        if (next === attachment.revision && now < attachment.expiresAt) return next;
        yield* release(id);
        return next === attachment.revision ? null : next;
      }),
    );
  yield* input.catalog.published.pipe(
    Stream.runForEach(({ projectId, revision: next }) =>
      Effect.gen(function* () {
        publishedRevisions.set(projectId, next);
        if (next === null) return;
        for (const [id, attachment] of [...attachments]) {
          if (attachment.projectId !== projectId || attachment.revision === null) continue;
          yield* serial(
            id,
            Effect.suspend(() => {
              const published = publishedRevisions.get(projectId);
              return attachments.get(id) === attachment &&
                published &&
                attachment.revision !== published
                ? release(id)
                : Effect.void;
            }),
          ).pipe(Effect.forkIn(owner));
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const openPluginServers = Effect.fnUntraced(function* (
    id: string,
    request: SessionPluginsRequest,
    plugin: CatalogPlugin,
  ) {
    if (!plugin.root || !plugin.package) return [];
    const installation = {
      packageRoot: plugin.root,
      dataRoot: join(input.home, "plugin-data", pluginRevision(plugin.id)),
      generation: plugin.package.digest,
      servers: plugin.package.mcpServers.filter(runnableServer),
    };
    const project = { spaceId: input.spaceId, projectId: request.projectId ?? "" };
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
            { approval: () => Effect.succeed("allow") },
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
  });

  const prepare = Effect.fnUntraced(function* (
    id: string,
    request: SessionPluginsRequest,
    { revision, entries }: PluginCatalogSnapshot,
    base: SessionPlugins,
  ) {
    const eligible = entries.filter(({ scope }) => includesProject(scope, request.projectId));
    const projection = yield* makeSkillProjection(input.home, revision, eligible).pipe(
      Effect.mapError(
        () => new PluginSessionPreparationError("Could not prepare the Session’s plugin Skills."),
      ),
    );
    const sessionScope = yield* Effect.scope;
    const prepared = yield* Effect.forEach(
      eligible,
      Effect.fnUntraced(function* (plugin) {
        const scope = yield* Scope.fork(sessionScope);
        return yield* Effect.gen(function* () {
          const skills = projection ? yield* projection.project(plugin) : [];
          const servers = yield* openPluginServers(id, request, plugin);
          return { plugin, skills, servers };
        }).pipe(
          Scope.provide(scope),
          Effect.catch((error) =>
            Scope.close(scope, Exit.fail(error)).pipe(
              Effect.andThen(Effect.logWarning("Skipped a plugin while preparing the Session")),
              Effect.annotateLogs({ pluginId: plugin.id }),
              Effect.as(null),
            ),
          ),
        );
      }),
    );
    const delivered = prepared.filter((plugin) => plugin !== null);
    const skills = delivered.flatMap((plugin) => plugin.skills);
    const skillsRoot = skills.length ? (projection?.root ?? null) : null;
    const catalogEntries = skillsRoot
      ? delivered.flatMap(({ plugin, skills }) => {
          if (!skills.length) return [];
          return [
            [
              plugin.id,
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
            input.broker
              .openSkillCatalog(catalogEntries)
              .pipe(
                Effect.mapError(
                  () =>
                    new PluginSessionPreparationError(
                      "Could not prepare the Session’s plugin Skill catalog.",
                    ),
                ),
              ),
            (lease) => input.broker.revokeLease(lease.id),
          )
        : null;
    return {
      ...base,
      skillsRoot,
      skills,
      mcpServers: delivered.flatMap((plugin) => plugin.servers),
      pluginIds: delivered
        .filter(
          ({ plugin: { package: pkg } }) =>
            pkg && (pkg.skills.some(({ valid }) => valid) || pkg.mcpServers.some(runnableServer)),
        )
        .map(({ plugin }) => plugin.id),
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
  });

  const emptyPlugins = (revision: string): SessionPlugins => ({
    revision,
    skillsRoot: null,
    skills: [],
    mcpServers: [],
    pluginIds: [],
    codexDisabledPluginIds: [],
  });
  // Codex loads plugins natively; its thread only needs the current out-of-scope overrides.
  const codexOverrides = Effect.fnUntraced(function* (projectId: string | null) {
    const snapshot = yield* input.catalog.read(projectId, codexCatalogWait);
    if (!snapshot)
      return yield* new PluginSessionPreparationError(
        "Could not read the installed plugins for this Session.",
      );
    return {
      ...emptyPlugins(snapshot.revision),
      codexDisabledPluginIds: snapshot.entries
        .filter(({ scope }) => !includesProject(scope, projectId))
        .map(({ id }) => id),
    };
  });

  const open = (id: string, request: SessionPluginsRequest) =>
    serial(
      id,
      Effect.gen(function* () {
        const { backend, projectId } = request;
        yield* release(id);
        if (backend === "codex") return yield* codexOverrides(projectId);
        const snapshot = yield* input.catalog.read(projectId, replyCatalogWait);
        if (!snapshot) {
          attachments.set(id, { projectId, revision: null });
          return null;
        }
        const base = emptyPlugins(snapshot.revision);
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const scope = yield* Scope.fork(owner);
            const now = yield* Clock.currentTimeMillis;
            attachments.set(id, {
              projectId,
              scope,
              revision: snapshot.revision,
              expiresAt: now + lifetime - 60_000,
            });
            return yield* restore(prepare(id, request, snapshot, base)).pipe(
              Scope.provide(scope),
              Effect.onError(() => release(id)),
            );
          }),
        );
      }),
    );
  return { open, revision, close: (id: string) => serial(id, release(id)) };
});
