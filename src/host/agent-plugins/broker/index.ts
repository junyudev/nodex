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
  type PluginMcpLeaseOptions,
} from "./contract";
import { skillCatalog, type SkillCatalogSource } from "./skill-catalog";
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
    scope.pluginId,
    scope.generation,
    scope.serverKey,
    scope.project.spaceId,
    scope.project.projectId,
    scope.principal.kind,
    scope.principal.id,
    scope.principal.kind === "interface-view" ? scope.principal.sessionId : null,
  ]);

type Upstream = Effect.Success<ReturnType<typeof makeUpstream>>;
type Entry = {
  readonly key: string;
  readonly owner: Scope.Closeable;
  readonly upstream: Upstream;
  readonly requests: FiberSet.FiberSet;
  refs: number;
};
type Credential = {
  readonly secret: Buffer;
  readonly key: string;
  readonly expiresAt: bigint;
  readonly httpBinding: "mcp-session" | undefined;
  connection?: symbol;
  sessionId?: string;
  lease?: Lease;
};
type LiveLease = {
  readonly credential: Credential;
  readonly revoked: Deferred.Deferred<never, PluginMcpFailure>;
  readonly authorize: Effect.Effect<boolean>;
};
type ServerLease = LiveLease & {
  readonly kind: "server";
  readonly scope: PluginMcpLeaseScope;
  readonly entry: Entry;
  readonly approval: PluginMcpApproval;
};
type CatalogLease = LiveLease & {
  readonly kind: "catalog";
  readonly source: SkillCatalogSource;
};
type Lease = ServerLease | CatalogLease;

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
  const upstreams = new Map<string, Entry>();
  const credentials = new Map<string, Credential>();
  const retiring = yield* FiberMap.make<symbol, void, never>().pipe(Scope.provide(owner));
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
      if (lease.kind === "catalog" || --lease.entry.refs !== 0) continue;
      upstreams.delete(lease.entry.key);
      unused.push(lease.entry);
    }
    for (const lease of leases)
      yield* Deferred.fail(lease.revoked, new PluginMcpFailure("lease_revoked"));
    for (const entry of unused)
      yield* FiberMap.run(
        retiring,
        Symbol(),
        shutdown(entry).pipe(
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
  const dispatch = <A>(lease: ServerLease, operation: Effect.Effect<A, PluginMcpFailure>) =>
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
      const authorized = Effect.gen(function* () {
        if (!(yield* lease.authorize)) return yield* new PluginMcpFailure("lease_revoked");
        const result = yield* operation;
        if (!(yield* lease.authorize)) return yield* new PluginMcpFailure("lease_revoked");
        return result;
      });
      const result = yield* Effect.raceFirst(authorized, Deferred.await(lease.revoked)).pipe(
        Effect.result,
      );
      if (!isLive(lease)) return yield* new PluginMcpFailure("lease_revoked");
      return yield* Effect.fromResult(result);
    });

  const serverProjection = (lease: ServerLease) => ({
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
          if (!(yield* lease.authorize)) return yield* new PluginMcpFailure("lease_revoked");
          return yield* dispatch(lease, connection.callTool(name, args));
        }),
      ),
  });

  const projection = (lease: Lease) => {
    const awaitRevoked = Deferred.await(lease.revoked);
    const readResource = (uri: string) =>
      lease.kind === "server" && lease.scope.principal.kind === "interface-view"
        ? withLease(
            lease,
            dispatch(
              lease,
              Effect.flatMap(lease.entry.upstream.get, (client) => client.readResource(uri)),
            ),
          )
        : Effect.fail(new PluginMcpFailure("approval_denied"));
    if (lease.kind === "server") return { ...serverProjection(lease), awaitRevoked, readResource };
    const catalog = skillCatalog(lease.source);
    return {
      awaitRevoked,
      readResource,
      listTools: withLease(lease, catalog.listTools),
      callTool: (name: string, args: Record<string, unknown>) =>
        withLease(lease, catalog.callTool(name, args)),
    };
  };

  yield* Effect.addFinalizer((exit) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          closed = true;
          yield* invalidate(activeLeases());
          credentials.clear();
        }),
      )
      .pipe(
        Effect.andThen(() => Fiber.joinAll(Array.from(retiring, ([, fiber]) => fiber))),
        Effect.ensuring(Scope.close(owner, exit)),
      ),
  );

  const origin = yield* listen((id, token, connection, sessionId) => {
    const credential = authenticate(id, token);
    if (!credential) return undefined;
    if (credential.httpBinding === "mcp-session") {
      if (sessionId !== credential.sessionId) return undefined;
      if (!credential.lease) return new PluginMcpFailure("lease_revoked");
      if (credential.sessionId !== undefined) return { projection: projection(credential.lease) };
      // Pooled clients can change sockets. Only the first attachment receives the session ID.
      credential.sessionId = randomBytes(32).toString("base64url");
      return { projection: projection(credential.lease), sessionId: credential.sessionId };
    }
    if (credential.connection && credential.connection !== connection) return undefined;
    if (!credential.lease) return new PluginMcpFailure("lease_revoked");
    credential.connection = connection;
    return { projection: projection(credential.lease) };
  }).pipe(Scope.provide(owner));

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

  const issue = Effect.fnUntraced(function* (
    key: string,
    maxLifetimeMs: number,
    httpBinding: Credential["httpBinding"],
    makeLease: (live: LiveLease) => Lease,
  ) {
    const id = randomBytes(18).toString("base64url");
    const bearerToken = randomBytes(32).toString("base64url");
    const revoked = yield* Deferred.make<never, PluginMcpFailure>();
    const expiresAt = clock.monotonicTimeNanosUnsafe() + BigInt(maxLifetimeMs) * 1_000_000n;
    const credential: Credential = {
      secret: Buffer.from(bearerToken),
      key,
      expiresAt,
      httpBinding,
    };
    credential.lease = makeLease({ credential, revoked, authorize: Effect.succeed(true) });
    credentials.set(id, credential);
    yield* Effect.sleep(maxLifetimeMs).pipe(
      Effect.andThen(revokeLease(id)),
      Effect.forkIn(owner, { startImmediately: true, uninterruptible: false }),
    );
    return { id, url: origin + leasePath(id), bearerToken };
  });

  const openSkillCatalog: PluginMcpBrokerService["openSkillCatalog"] = (
    source,
    options?: Pick<PluginMcpLeaseOptions, "authorize">,
  ) =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.suspend(() => {
          if (closed) return Effect.fail(new PluginMcpFailure("broker_closed"));
          return issue("", defaultLifetimeMs, "mcp-session", (live) => ({
            ...live,
            kind: "catalog",
            source,
            authorize: options?.authorize ?? live.authorize,
          }));
        }),
      ),
    );

  const openLease: PluginMcpBrokerService["openLease"] = (
    requestedScope,
    installation,
    {
      approval = () => Effect.succeed("ask" as const),
      authorize = Effect.succeed(true),
      maxLifetimeMs = defaultLifetimeMs,
      httpBinding,
    }: PluginMcpLeaseOptions = {},
  ) =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (closed) return yield* new PluginMcpFailure("broker_closed");
          if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0)
            return yield* new PluginMcpFailure("invalid_configuration");
          const scope = structuredClone(requestedScope);
          if (installation.generation !== scope.generation)
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
              owner: child,
              upstream,
              requests,
              refs: 0,
            };
            upstreams.set(key, entry);
          }
          entry.refs++;
          return yield* issue(key, maxLifetimeMs, httpBinding, (live) => ({
            ...live,
            kind: "server",
            scope,
            entry,
            approval,
            authorize,
          }));
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
    openLease,
    openSkillCatalog,
    revokeLease,
    awaitRevoked: (scope, credential) => use(scope, credential, (lease) => lease.awaitRevoked),
    readResource: (scope, credential, uri) =>
      use(scope, credential, (lease) => lease.readResource(uri)),
    listTools: (scope, credential) => use(scope, credential, (lease) => lease.listTools),
    callTool: (scope, credential, name, args = {}) =>
      use(scope, credential, (lease) => lease.callTool(name, args)),
  };
});
