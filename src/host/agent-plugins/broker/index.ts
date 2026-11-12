import { randomBytes, timingSafeEqual } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
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
const DEFAULT_SHUTDOWN_GRACE_MS = 35_000;

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
  readonly installationId: string;
  readonly owner: Scope.Closeable;
  readonly upstream: Upstream;
  readonly requests: FiberSet.FiberSet;
  refs: number;
};
type Credential = {
  readonly secret: Buffer;
  readonly key: string;
  readonly expiresAt: bigint;
  connection?: symbol;
  lease?: Lease;
};
type Lease = {
  readonly credential: Credential;
  readonly scope: PluginMcpLeaseScope;
  readonly entry: Entry;
  readonly revoked: Deferred.Deferred<never, PluginMcpFailure>;
  readonly approval: PluginMcpApproval;
};

/** Compose in the Profile Scope. Trusted callers supply authoritative activation and principal facts. */
export const makePluginMcpBroker = Effect.fn("PluginMcpBroker.make")(function* (
  options: PluginMcpBrokerOptions,
): Effect.fn.Return<PluginMcpBrokerService, PluginMcpFailure, Scope.Scope> {
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const restartBudget = options.restartBudget ?? 2;
  if (
    !Number.isSafeInteger(restartBudget) ||
    restartBudget < 0 ||
    !Number.isSafeInteger(shutdownGraceMs) ||
    shutdownGraceMs <= 0
  )
    return yield* new PluginMcpFailure("invalid_configuration");

  const clock = yield* Clock.Clock;
  const owner = yield* Scope.make();
  const gate = yield* Semaphore.make(1);
  const installations = new Map<string, PluginMcpInstallation>();
  const upstreams = new Map<string, Entry>();
  const credentials = new Map<string, Credential>();
  const retiring = yield* FiberMap.make<
    readonly [installationId: string, id: symbol],
    void,
    never
  >().pipe(Scope.provide(owner));
  let closed = false;

  const shutdown = (entry: Entry) =>
    Fiber.awaitAll([...entry.requests]).pipe(
      Effect.asVoid,
      Effect.timeoutOrElse({
        duration: shutdownGraceMs,
        orElse: () => Effect.fail(new PluginMcpFailure("shutdown_timeout")),
      }),
      Effect.ensuring(
        FiberSet.clear(entry.requests).pipe(Effect.andThen(Scope.close(entry.owner, Exit.void))),
      ),
    );

  const invalidate = Effect.fnUntraced(function* (leases: readonly Lease[]) {
    const unused: Entry[] = [];
    // Revoke every credential before waiting for any upstream to drain.
    for (const lease of leases) {
      delete lease.credential.lease;
      if (--lease.entry.refs !== 0) continue;
      upstreams.delete(lease.entry.key);
      unused.push(lease.entry);
    }
    for (const lease of leases)
      yield* Deferred.fail(lease.revoked, new PluginMcpFailure("lease_revoked"));
    for (const entry of unused)
      yield* FiberMap.run(
        retiring,
        [entry.installationId, Symbol()],
        shutdown(entry).pipe(
          // Installation publication follows a durable commit and cannot roll it back.
          Effect.catch((failure) =>
            Effect.logWarning("Plugin MCP shutdown exceeded its grace period", failure),
          ),
          Effect.interruptible,
        ),
      );
  });

  const activeLeases = () =>
    Array.from(credentials.values()).flatMap(({ lease }) => (lease ? [lease] : []));

  const expired = ({ expiresAt }: Credential) => clock.monotonicTimeNanosUnsafe() >= expiresAt;
  const isLive = (lease: Lease) =>
    !closed && lease.credential.lease === lease && !expired(lease.credential);

  const authenticate = (id: string, token: string) => {
    if (closed || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const credential = credentials.get(id);
    const presented = Buffer.from(token);
    return credential && !expired(credential) && timingSafeEqual(credential.secret, presented)
      ? credential
      : undefined;
  };

  // An upstream request belongs to the connection. Revoking the lease stops delivery, while
  // an ordinary downstream disconnect can still cancel work on behalf of a live lease.
  const dispatch = <A>(lease: Lease, operation: Effect.Effect<A, PluginMcpFailure>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!isLive(lease)) return yield* new PluginMcpFailure("lease_revoked");
        const request = yield* FiberSet.run(
          lease.entry.requests,
          Effect.suspend(() =>
            isLive(lease) ? operation : Effect.fail(new PluginMcpFailure("lease_revoked")),
          ).pipe(Effect.interruptible),
        );
        return yield* restore(Fiber.join(request)).pipe(
          Effect.onInterrupt(() => (isLive(lease) ? Fiber.interrupt(request) : Effect.void)),
        );
      }),
    );

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
      dispatch(
        lease,
        Effect.flatMap(lease.entry.upstream.get, (connection) => connection.listTools),
      ),
    ),
    callTool: (name: string, args: Record<string, unknown>) =>
      withLease(
        lease,
        Effect.gen(function* () {
          const { connection, tools } = yield* dispatch(
            lease,
            Effect.gen(function* () {
              const connection = yield* lease.entry.upstream.get;
              const tools = yield* connection.listTools;
              return { connection, tools };
            }),
          );
          const tool = tools.find((candidate) => candidate.name === name);
          if (!tool) return yield* new PluginMcpFailure("unknown_tool");
          const decision = yield* Effect.suspend(() =>
            isLive(lease)
              ? lease.approval({ scope: lease.scope, tool, arguments: args })
              : Effect.fail(new PluginMcpFailure("lease_revoked")),
          ).pipe(
            Effect.timeoutOrElse({
              duration: options.requestTimeoutMs ?? 30_000,
              orElse: () => Effect.succeed("ask" as const),
            }),
            Effect.catchDefect(() => Effect.succeed("ask" as const)),
          );
          if (decision === "deny") return yield* new PluginMcpFailure("approval_denied");
          if (decision !== "allow") return yield* new PluginMcpFailure("approval_required");
          return yield* dispatch(lease, connection.callTool(name, args));
        }),
      ),
  });

  yield* Effect.addFinalizer((exit) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          closed = true;
          installations.clear();
          yield* invalidate(activeLeases());
          credentials.clear();
        }),
      )
      .pipe(
        Effect.andThen(() => Fiber.joinAll(Array.from(retiring, ([, fiber]) => fiber))),
        Effect.ensuring(Scope.close(owner, exit)),
      ),
  );

  const origin = yield* listen((id, token, connection) => {
    const credential = authenticate(id, token);
    if (!credential || (credential.connection && credential.connection !== connection))
      return undefined;
    if (!credential.lease) return new PluginMcpFailure("lease_revoked");
    // In-process issuance precedes HTTP attachment. The first authenticated connection binds it.
    credential.connection = connection;
    return projection(credential.lease);
  }).pipe(Scope.provide(owner));

  const publishInstallation: PluginMcpBrokerService["publishInstallation"] = (
    installationId,
    installation,
  ) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const pending = yield* gate.withPermit(
          Effect.gen(function* () {
            if (closed) return [];
            if (installation) installations.set(installationId, structuredClone(installation));
            else installations.delete(installationId);
            yield* invalidate(
              activeLeases().filter(
                ({ scope }) =>
                  scope.installationId === installationId &&
                  (installation?.generation !== scope.generation ||
                    !projectActive(installation, scope) ||
                    !installation.servers.some(({ key }) => key === scope.serverKey)),
              ),
            );
            return [...retiring].flatMap(([[id], fiber]) => (id === installationId ? [fiber] : []));
          }),
        );
        yield* Fiber.joinAll(pending);
      }),
    );

  const revokeLease: PluginMcpBrokerService["revokeLease"] = (id) =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.suspend(() => {
          const credential = credentials.get(id);
          if (!credential) return Effect.void;
          if (expired(credential)) credentials.delete(id);
          return credential.lease ? invalidate([credential.lease]) : Effect.void;
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
            const requests = yield* FiberSet.make().pipe(Scope.provide(child));
            entry = {
              key,
              installationId: scope.installationId,
              owner: child,
              upstream,
              requests,
              refs: 0,
            };
            upstreams.set(key, entry);
          }
          const id = randomBytes(18).toString("base64url");
          const bearerToken = randomBytes(32).toString("base64url");
          const revoked = yield* Deferred.make<never, PluginMcpFailure>();
          entry.refs++;
          const expiresAt = clock.monotonicTimeNanosUnsafe() + BigInt(maxLifetimeMs) * 1_000_000n;
          // Retain only authenticated credential metadata until its original expiry.
          const credential: Credential = { secret: Buffer.from(bearerToken), key, expiresAt };
          credential.lease = { credential, scope, entry, revoked, approval };
          credentials.set(id, credential);
          yield* Effect.sleep(maxLifetimeMs).pipe(
            Effect.andThen(revokeLease(id)),
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
      const authenticated = authenticate(credential.id, credential.bearerToken);
      if (!authenticated || authenticated.key !== keyFor(scope))
        return Effect.fail(new PluginMcpFailure("invalid_lease"));
      if (!authenticated.lease) return Effect.fail(new PluginMcpFailure("lease_revoked"));
      return operation(projection(authenticated.lease));
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
