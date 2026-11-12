import { createHash, randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  effectivePluginContributions,
  samePluginProject,
  type PluginInstallationRecord,
  type PluginProject,
} from "../../shared/agent-plugins/installation-registry";
import type { PluginMcpLease } from "../../shared/agent-plugins/mcp-lease";
import type { PluginMcpBrokerService } from "./broker/contract";
import { makeCodexPluginProjection } from "./CodexPluginProjection";

export const makeCodexPluginDelivery = Effect.fnUntraced(function* (
  home: string,
  broker: PluginMcpBrokerService,
) {
  const projection = yield* makeCodexPluginProjection(home);
  const lock = yield* Semaphore.make(1);
  const installations = new Map<string, PluginInstallationRecord>();
  const pendingWithdrawal = new Set<string>();
  const projects = new Map<string, { project: PluginProject; revision: string }>();
  const leases = new Map<
    string,
    {
      readonly project: PluginProject;
      readonly leases: readonly PluginMcpLease[];
    }
  >();
  const contributions = (project: PluginProject) =>
    effectivePluginContributions(
      { format: 1, revision: 0, installations: [...installations.values()] },
      project,
    );
  const active = (installation: PluginInstallationRecord | undefined, project: PluginProject) =>
    installation?.enabled === true &&
    installation.projects.some((entry) => samePluginProject(entry, project));

  const release = Effect.fnUntraced(function* (threadKey: string) {
    const entry = leases.get(threadKey);
    if (!entry) return;
    leases.delete(threadKey);
    yield* Effect.forEach(entry.leases, (lease) => broker.revokeLease(lease.id), { discard: true });
  });

  const projectKey = ({ spaceId, projectId }: PluginProject) =>
    JSON.stringify([spaceId, projectId]);
  const withdraw = Effect.fnUntraced(function* (project: PluginProject) {
    const key = projectKey(project);
    pendingWithdrawal.add(key);
    for (const [threadKey, entry] of leases) {
      if (samePluginProject(entry.project, project)) yield* release(threadKey);
    }
    yield* projection.withdraw(project);
    pendingWithdrawal.delete(key);
  });

  const publish = Effect.fnUntraced(function* (
    id: string,
    installation: PluginInstallationRecord | null,
  ) {
    const before = installations.get(id);
    if (installation) installations.set(id, installation);
    else installations.delete(id);
    for (const entry of projects.values()) {
      const { project } = entry;
      const wasActive = active(before, project);
      const isActive = active(installation ?? undefined, project);
      if (
        (!wasActive && !isActive) ||
        (wasActive && isActive && before?.activeGeneration === installation?.activeGeneration)
      )
        continue;
      entry.revision = randomUUID();
      yield* withdraw(project).pipe(
        Effect.andThen(projection.reconcile(project, contributions(project))),
        Effect.catch((error) =>
          Effect.logError("Could not withdraw Codex Plugin projection", error),
        ),
      );
    }
  }, lock.withPermit);

  const hasContributions = (project: PluginProject) =>
    lock.withPermit(
      Effect.sync(
        () => pendingWithdrawal.has(projectKey(project)) || contributions(project).length > 0,
      ),
    );

  const status = Effect.fnUntraced(function* (project: PluginProject, enabled: boolean) {
    const key = projectKey(project);
    if (!enabled) {
      projects.delete(key);
      yield* withdraw(project);
      return null;
    }
    if (pendingWithdrawal.has(key)) yield* withdraw(project);
    if (contributions(project).length === 0) return null;
    const entry = projects.get(key) ?? { project, revision: randomUUID() };
    projects.set(key, entry);
    return entry.revision;
  }, lock.withPermit);

  const attach = Effect.fnUntraced(
    function* (
      project: PluginProject,
      sessionId: string,
      threadKey: string,
      expectedRevision: string,
    ) {
      const current = contributions(project);
      if (
        pendingWithdrawal.has(projectKey(project)) ||
        current.length === 0 ||
        projects.get(projectKey(project))?.revision !== expectedRevision
      )
        return null;
      const plan = yield* projection.reconcile(project, current);
      yield* release(threadKey);
      const issued: PluginMcpLease[] = [];
      const lifetimeMs = 8 * 60 * 60 * 1000;
      const expiresAt = Date.now() + lifetimeMs;
      const servers = yield* Effect.forEach(
        current.flatMap((entry) => entry.mcpServers.map((server) => ({ entry, server }))),
        ({ entry, server }) =>
          broker
            .openLease(
              {
                installationId: entry.installationId,
                generation: entry.generation,
                serverKey: server.key,
                project,
                principal: { kind: "agent-session", id: sessionId },
              },
              {
                maxLifetimeMs: lifetimeMs,
                httpBinding: "mcp-session",
                // The authenticated Codex client applies native Session MCP approval before dispatch.
                // Revocation remains a broker decision even for calls Codex has approved.
                approval: () => Effect.succeed("allow"),
              },
            )
            .pipe(
              Effect.map((lease) => {
                issued.push(lease);
                return {
                  key:
                    "nodex_plugin_" +
                    createHash("sha256")
                      .update(JSON.stringify([entry.installationId, server.key]))
                      .digest("hex")
                      .slice(0, 24),
                  url: lease.url,
                  authorization: "Bearer " + lease.bearerToken,
                };
              }),
            ),
      ).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Success"
            ? Effect.void
            : Effect.forEach(issued, (lease) => broker.revokeLease(lease.id), { discard: true }),
        ),
      );
      leases.set(threadKey, { project, leases: issued });
      return {
        revision: expectedRevision,
        root: plan.skills.length > 0 ? plan.root : null,
        identities: current.flatMap(({ installationId }) => {
          const entry = installations.get(installationId);
          return entry ? [entry.package.identity.name] : [];
        }),
        servers,
        expiresAt: issued.length ? expiresAt : null,
      };
    },
    lock.withPermit,
    Effect.uninterruptible,
  );

  return {
    publish,
    hasContributions,
    status,
    attach,
    release: (key: string) => lock.withPermit(release(key)),
  };
});

export class CodexPluginDelivery extends Context.Service<
  CodexPluginDelivery,
  Effect.Success<ReturnType<typeof makeCodexPluginDelivery>>
>()("nodex/host/CodexPluginDelivery") {}
