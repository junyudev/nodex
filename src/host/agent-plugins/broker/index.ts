import { randomBytes, timingSafeEqual } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { PluginMcpLease, PluginMcpLeaseScope } from "../../../shared/agent-plugins/mcp-lease";
import {
  PluginMcpFailure,
  type PluginMcpApproval,
  type PluginMcpBrokerService,
  type PluginMcpBrokerOptions,
  type PluginMcpInstallation,
} from "./contract";
import { leasePath, listen } from "./http";
import { makeUpstream } from "./upstream";

export * from "./contract";
export type {
  PluginMcpLease,
  PluginMcpLeaseScope,
  PluginMcpPrincipal,
  PluginMcpProject,
} from "../../../shared/agent-plugins/mcp-lease";

const defaultLifetimeMs = 8 * 60 * 60 * 1000;

const keyFor = (scope: PluginMcpLeaseScope) =>
  JSON.stringify([
    scope.installationId,
    scope.generation,
    scope.serverKey,
    scope.project.spaceId,
    scope.project.projectId,
    scope.principal.kind,
    scope.principal.id,
  ]);

function projectActive(installation: PluginMcpInstallation, scope: PluginMcpLeaseScope) {
  return installation.activeProjects.some(
    (project) =>
      project.spaceId === scope.project.spaceId && project.projectId === scope.project.projectId,
  );
}

type Upstream = Effect.Success<ReturnType<typeof makeUpstream>>;
type Entry = {
  readonly key: string;
  readonly owner: Scope.Closeable;
  readonly upstream: Upstream;
  refs: number;
};
type Lease = {
  readonly id: string;
  readonly secret: Buffer;
  readonly scope: PluginMcpLeaseScope;
  readonly entry: Entry;
  readonly revoked: Deferred.Deferred<never, PluginMcpFailure>;
  readonly approval: PluginMcpApproval;
  readonly expiresAt: bigint;
  connection?: symbol;
};

/** Compose in the Profile Scope. Trusted callers supply authoritative activation and principal facts. */
export const makePluginMcpBroker = Effect.fn("PluginMcpBroker.make")(function* (
  options: PluginMcpBrokerOptions,
): Effect.fn.Return<PluginMcpBrokerService, PluginMcpFailure, Scope.Scope> {
  if (!Number.isSafeInteger(options.restartBudget ?? 2) || (options.restartBudget ?? 2) < 0)
    return yield* new PluginMcpFailure("invalid_configuration");
  const parent = yield* Scope.Scope;
  const clock = yield* Clock.Clock;
  const owner = yield* Scope.fork(parent);
  const gate = yield* Semaphore.make(1);
  const installations = new Map<string, PluginMcpInstallation>();
  const upstreams = new Map<string, Entry>();
  const leases = new Map<string, Lease>();
  let closed = false;

  const invalidate = Effect.fnUntraced(function* (retired: readonly Lease[]) {
    const unused: Entry[] = [];
    // Remove every credential before interrupting or closing any one upstream.
    for (const lease of retired) {
      leases.delete(lease.id);
      if (--lease.entry.refs !== 0) continue;
      upstreams.delete(lease.entry.key);
      unused.push(lease.entry);
    }
    for (const lease of retired)
      yield* Deferred.fail(lease.revoked, new PluginMcpFailure("lease_revoked"));
    yield* Effect.forEach(unused, ({ owner }) => Scope.close(owner, Exit.void), {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const isLive = (lease: Lease) =>
    !closed && leases.get(lease.id) === lease && clock.monotonicTimeNanosUnsafe() < lease.expiresAt;

  const authorized = (id: string, token: string) => {
    if (closed || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const lease = leases.get(id);
    const presented = Buffer.from(token);
    return lease && isLive(lease) && timingSafeEqual(lease.secret, presented) ? lease : undefined;
  };

  const withLease = <A>(lease: Lease, operation: Effect.Effect<A, PluginMcpFailure>) =>
    Effect.gen(function* () {
      if (!isLive(lease)) return yield* new PluginMcpFailure("lease_revoked");
      const result = yield* Effect.raceFirst(operation, Deferred.await(lease.revoked)).pipe(
        Effect.result,
      );
      if (!isLive(lease)) return yield* new PluginMcpFailure("lease_revoked");
      return yield* Effect.fromResult(result);
    });

  const projection = (lease: Lease) => ({
    listTools: withLease(
      lease,
      Effect.flatMap(lease.entry.upstream.get, (connection) => connection.listTools),
    ),
    callTool: (name: string, args: Record<string, unknown>) =>
      withLease(
        lease,
        Effect.gen(function* () {
          const connection = yield* lease.entry.upstream.get;
          const tools = yield* connection.listTools;
          const tool = tools.find((candidate) => candidate.name === name);
          if (!tool) return yield* new PluginMcpFailure("unknown_tool");
          const decision = yield* Effect.suspend(() =>
            lease.approval({ scope: lease.scope, tool, arguments: args }),
          ).pipe(
            Effect.timeoutOrElse({
              duration: options.requestTimeoutMs ?? 30_000,
              orElse: () => Effect.succeed("ask" as const),
            }),
            Effect.catchDefect(() => Effect.succeed("ask" as const)),
          );
          if (decision === "deny") return yield* new PluginMcpFailure("approval_denied");
          if (decision !== "allow") return yield* new PluginMcpFailure("approval_required");
          if (!isLive(lease)) return yield* new PluginMcpFailure("lease_revoked");
          if (!connection.healthy()) return yield* new PluginMcpFailure("upstream_unavailable");
          return yield* connection.callTool(name, args);
        }),
      ),
  });

  const origin = yield* listen((id, token, connection) => {
    const lease = authorized(id, token);
    if (!lease || (lease.connection && lease.connection !== connection)) return undefined;
    // In-process issuance precedes HTTP attachment. The first authenticated connection binds it.
    lease.connection = connection;
    return projection(lease);
  }).pipe(Scope.provide(owner));

  yield* Effect.addFinalizer(() =>
    gate.withPermit(
      Effect.gen(function* () {
        closed = true;
        installations.clear();
        yield* invalidate([...leases.values()]);
      }),
    ),
  );

  const publishInstallation: PluginMcpBrokerService["publishInstallation"] = (
    installationId,
    installation,
  ) =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (closed) return;
          if (installation) installations.set(installationId, structuredClone(installation));
          else installations.delete(installationId);
          yield* invalidate(
            [...leases.values()].filter(
              ({ scope }) =>
                scope.installationId === installationId &&
                (installation?.generation !== scope.generation ||
                  !projectActive(installation, scope) ||
                  !installation.servers.some(({ key }) => key === scope.serverKey)),
            ),
          );
        }),
      ),
    );

  const revokeLease: PluginMcpBrokerService["revokeLease"] = (id) =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.suspend(() => {
          const lease = leases.get(id);
          return lease ? invalidate([lease]) : Effect.void;
        }),
      ),
    );

  const openLease: PluginMcpBrokerService["openLease"] = (
    requestedScope,
    { approval = () => Effect.succeed("ask" as const), maxLifetimeMs = defaultLifetimeMs } = {},
  ) =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (closed) return yield* new PluginMcpFailure("broker_closed");
          if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0)
            return yield* new PluginMcpFailure("invalid_configuration");
          const scope = structuredClone(requestedScope);
          const installation = installations.get(scope.installationId);
          if (installation?.generation !== scope.generation || !projectActive(installation, scope))
            return yield* new PluginMcpFailure("server_inactive");
          const server = installation.servers.find(({ key }) => key === scope.serverKey);
          if (!server) return yield* new PluginMcpFailure("server_inactive");

          const key = keyFor(scope);
          let entry = upstreams.get(key);
          if (!entry) {
            const child = yield* Scope.fork(owner);
            const upstream = yield* makeUpstream(scope, installation, server, options).pipe(
              Scope.provide(child),
            );
            entry = { key, owner: child, upstream, refs: 0 };
            upstreams.set(key, entry);
          }
          const id = randomBytes(18).toString("base64url");
          const bearerToken = randomBytes(32).toString("base64url");
          const revoked = yield* Deferred.make<never, PluginMcpFailure>();
          entry.refs++;
          const expiresAt = clock.monotonicTimeNanosUnsafe() + BigInt(maxLifetimeMs) * 1_000_000n;
          leases.set(id, {
            id,
            secret: Buffer.from(bearerToken),
            scope,
            entry,
            revoked,
            approval,
            expiresAt,
          });
          yield* Effect.raceFirst(Effect.sleep(maxLifetimeMs), Deferred.await(revoked)).pipe(
            Effect.andThen(revokeLease(id)),
            Effect.ignore,
            Effect.forkIn(owner, { startImmediately: true, uninterruptible: false }),
          );
          return { id, url: origin + leasePath(id), bearerToken };
        }),
      ),
    );

  const use = <A>(
    scope: PluginMcpLeaseScope,
    credential: PluginMcpLease,
    operation: (lease: ReturnType<typeof projection>) => Effect.Effect<A, PluginMcpFailure>,
  ) =>
    Effect.suspend(() => {
      const lease = authorized(credential.id, credential.bearerToken);
      if (!lease || lease.entry.key !== keyFor(scope))
        return Effect.fail(new PluginMcpFailure("invalid_lease"));
      return operation(projection(lease));
    });

  return {
    publishInstallation,
    openLease,
    revokeLease,
    listTools: (scope, credential) => use(scope, credential, (lease) => lease.listTools),
    callTool: (scope, credential, name, args = {}) =>
      use(scope, credential, (lease) => lease.callTool(name, args)),
  };
});
