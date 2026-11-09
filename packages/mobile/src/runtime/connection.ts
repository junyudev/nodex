import {
  MOBILE_PROTOCOL_REVISION,
  MOBILE_MAX_MESSAGE_BYTES,
  MobileEnvelopeSchema,
  parseDeviceLinkUri,
  HelloSchema,
  spaceMemberKey,
  type Hello,
  type MobileEnvelope,
} from "@nodex/mobile-protocol";
import { z } from "zod";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { createProjection } from "./projection";
import { Platform, type MobilePlatform } from "./platform";
import { decodeUtf8, encodeUtf8 } from "./encoding";
import { RpcClient, disconnected, RpcFailure } from "./rpc-client";
import type { PinnedTlsFailure } from "./pinned-tls";
import { orderRoutes } from "./routes";

const SavedHostSchema = z
  .object({
    hostId: z.string(),
    hostName: z.string(),
    spaceId: z.string().min(1),
    spaceKind: HelloSchema.shape.spaceKind,
    memberId: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/iu),
    routes: z.array(z.string()),
    pairedAt: z.number(),
    deviceId: z.string().min(1),
    lastConnectedRoute: z.string().nullable(),
  })
  .refine((host) => host.hostId === spaceMemberKey(host.spaceId, host.memberId));
/** Public enrollment metadata; the opaque hostId is the (Space, Member) partition key. */
export type SavedHost = z.infer<typeof SavedHostSchema>;
/** Enrollment identity is known before the first hello supplies Space presentation. */
type EnrolledHost = Omit<SavedHost, "spaceKind">;
export type ConnectionState = {
  status:
    | "idle"
    | "connecting"
    | "connected"
    | "offline"
    | "unavailable"
    | "incompatible"
    | "revoked";
  hello: Hello | null;
  message: string | null;
};
type FailureCode =
  | "invalid"
  | "expired"
  | "rejected"
  | "unreachable"
  | "incompatible"
  | "busy"
  | "revoked"
  | "pin"
  | "locked";
class RouteFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "RouteFailure";
  }
}
const noRoutes = () =>
  new RouteFailure("unreachable", "Can't reach this Space. If its address changed, link again.");
const incompatible = () =>
  new RouteFailure("incompatible", "Update Nodex Mobile or the Space host to connect.");
const revoked = () =>
  new RouteFailure("revoked", "Access revoked. Link this phone again to reconnect.");
const tlsFailure = (error: PinnedTlsFailure) => {
  if (error.code === "pin")
    return new RouteFailure(
      "pin",
      "The host certificate changed. Link again to trust its new certificate.",
    );
  return noRoutes();
};
const EnrollmentSchema = z.object({
  space_id: z.string().min(1),
  space_name: z.string(),
  member_id: z.string().min(1),
  device_id: z.string().min(1),
  device_credential: z.string().regex(/^[a-f0-9]{64}$/u),
});
const SessionSchema = z.object({
  session_token: z.string().regex(/^[a-f0-9]{64}$/u),
  expires_at: z.number().int().safe(),
  principal: z.object({ space_id: z.string(), member_id: z.string(), device_id: z.string() }),
});
const RecoverySchema = z.object({
  payload: z.object({ recovery: z.object({ kind: z.string() }) }),
});
const CatalogSchema = z.object({
  hosts: z.array(SavedHostSchema),
  activeHostId: z.string().nullable(),
  credentials: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
});
type Catalog = z.infer<typeof CatalogSchema>;
const emptyCatalog = (): Catalog => ({ hosts: [], activeHostId: null, credentials: {} });
const locked = () =>
  new RouteFailure(
    "locked",
    "Saved Space credentials are unavailable. Unlock this phone and retry.",
  );
export type ConnectionLink = {
  route: string;
  hello: Hello;
  send(envelope: MobileEnvelope): Effect.Effect<void, RpcFailure>;
  /** `renew` ends this link so the next connection renews the session at once. */
  take: Effect.Effect<MobileEnvelope | "dropped" | "renew", RouteFailure>;
  expiresAt: number;
};
const CATALOG_KEY = "nodex.mobile.spaces.v1";
const endpoint = (route: string, path: string, socket = false) => {
  const url = new URL(path, route);
  url.protocol = socket ? "wss:" : "https:";
  return url.href;
};
const uniqueRoutes = (routes: readonly string[]) => [
  ...new Set(
    routes.filter((route) => {
      try {
        const url = new URL(route);
        return (
          url.protocol === "https:" &&
          !!url.hostname &&
          !url.username &&
          !url.password &&
          !url.hash &&
          !url.search &&
          url.pathname === "/"
        );
      } catch {
        return false;
      }
    }),
  ),
];
/** The address that worked last leads its kind of address; see `orderRoutes`. */
const savedRoutes = (host: EnrolledHost) =>
  orderRoutes(
    uniqueRoutes([...(host.lastConnectedRoute ? [host.lastConnectedRoute] : []), ...host.routes]),
  );
const routeFailure = (failures: readonly RouteFailure[]) =>
  failures.find((e) => e.code === "revoked") ??
  failures.find((e) => e.code === "incompatible" || e.code === "pin") ??
  failures[0] ??
  noRoutes();
/** The host's own answer holds for every address, so another route cannot change it. */
const decisive = (error: RouteFailure) =>
  error.code === "revoked" || error.code === "incompatible" || error.code === "pin";
/**
 * Tries a Space's addresses together, the first offset by a quarter second each. The first to
 * connect wins; the first decisive refusal ends the race at once rather than after every other
 * address times out; otherwise the most telling failure is reported.
 */
const raceRoutes = <A, R>(
  routes: readonly string[],
  attempt: (route: string) => Effect.Effect<A, RouteFailure, R>,
) =>
  Effect.gen(function* () {
    if (!routes.length) return yield* Effect.fail(noRoutes());
    const failures: RouteFailure[] = [];
    const outcome = yield* Effect.raceAll(
      routes.map((route, index) =>
        Effect.gen(function* () {
          if (index) yield* Effect.sleep(index * 250);
          return { ok: true as const, value: yield* attempt(route) };
        }).pipe(
          Effect.catch((error) => {
            failures.push(error);
            return decisive(error)
              ? Effect.succeed({ ok: false as const, error })
              : Effect.fail(error);
          }),
        ),
      ),
    ).pipe(Effect.catch(() => Effect.fail(routeFailure(failures))));
    if (!outcome.ok) return yield* Effect.fail(outcome.error);
    return outcome.value;
  });

const request = Effect.fn("MobileConnection.request")(function* <A>(
  platform: MobilePlatform,
  route: string,
  fingerprint: string,
  path: string,
  body: unknown,
  schema: z.ZodType<A>,
) {
  const response = yield* platform.pinnedTls
    .request({
      url: endpoint(route, path),
      fingerprint,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeUtf8(JSON.stringify(body)),
      timeoutMs: 8_000,
    })
    .pipe(Effect.mapError(tlsFailure));
  const json = yield* Effect.try({
    try: (): unknown => JSON.parse(decodeUtf8(response.body)),
    catch: noRoutes,
  });
  if (response.status < 200 || response.status >= 300) {
    const recovery = RecoverySchema.safeParse(json);
    if (
      path === "/session" &&
      recovery.success &&
      recovery.data.payload.recovery.kind === "remote_access_withdrawn"
    )
      return yield* Effect.fail(revoked());
    if (response.status === 429)
      return yield* Effect.fail(
        new RouteFailure("busy", "The Space host is busy. Try again shortly."),
      );
    return yield* Effect.fail(
      new RouteFailure(
        "rejected",
        "This device link is no longer available. Show a new link in the Space’s settings.",
      ),
    );
  }
  return yield* Effect.try({ try: () => schema.parse(json), catch: incompatible });
});
/** Renewable sessions are memory-only and share one renewal lane, like desktop sessions. */
const makeSessionCredentials = Effect.fnUntraced(function* (platform: MobilePlatform) {
  const gate = yield* Semaphore.make(1);
  const cached = new Map<string, { credential: string; session: z.infer<typeof SessionSchema> }>();
  return {
    invalidate: (key: string) => cached.delete(key),
    renew: (host: EnrolledHost, credential: string) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const previous = cached.get(host.hostId);
          if (
            previous?.credential === credential &&
            platform.now() < previous.session.expires_at * 1000 - 60_000
          )
            return previous.session;
          // Race addresses within the one renewal lane: a stalled route must not hold
          // every WebSocket attempt behind its own HTTPS timeout.
          const session = yield* raceRoutes(savedRoutes(host), (route) =>
            Effect.gen(function* () {
              const result = yield* request(
                platform,
                route,
                host.fingerprint,
                "/session",
                { device_credential: credential },
                SessionSchema,
              );
              if (
                result.principal.space_id !== host.spaceId ||
                result.principal.member_id !== host.memberId ||
                result.principal.device_id !== host.deviceId
              )
                return yield* Effect.fail(incompatible());
              return result;
            }),
          );
          cached.set(host.hostId, { credential, session });
          return session;
        }),
      ),
  };
});
type SessionCredentials = Effect.Success<ReturnType<typeof makeSessionCredentials>>;

const dial = Effect.fn("MobileConnection.dial")(function* (
  platform: MobilePlatform,
  route: string,
  host: EnrolledHost,
  session: z.infer<typeof SessionSchema>,
  sessions: SessionCredentials,
) {
  const socket = yield* platform.pinnedTls
    .openSocket({
      url: endpoint(route, "/core/v1/phone", true),
      fingerprint: host.fingerprint,
      headers: { Authorization: `Bearer ${session.session_token}` },
      timeoutMs: 8_000,
    })
    .pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          sessions.invalidate(host.hostId);
        }),
      ),
      Effect.mapError(tlsFailure),
    );
  const receive = Effect.fnUntraced(function* (
    ready: boolean,
  ): Effect.fn.Return<MobileEnvelope | "dropped" | "renew", RouteFailure> {
    while (true) {
      const event = yield* socket.take.pipe(Effect.mapError(tlsFailure));
      if (event.type === "close") {
        // The host asks for a fresh session; only that renewal can say whether access remains.
        if (event.code === 4401) {
          sessions.invalidate(host.hostId);
          if (ready) return "renew";
        }
        return yield* Effect.fail(
          event.code === 4403 ? revoked() : event.code === 4406 ? incompatible() : noRoutes(),
        );
      }
      const parsed = yield* Effect.try({
        try: () =>
          MobileEnvelopeSchema.safeParse(
            JSON.parse(typeof event.data === "string" ? event.data : decodeUtf8(event.data)),
          ),
        catch: incompatible,
      });
      if (parsed.success) return parsed.data;
      if (!ready) return yield* Effect.fail(incompatible());
      return "dropped";
    }
  });
  const first = yield* receive(false);
  if (
    first === "dropped" ||
    first === "renew" ||
    first.t !== "hello" ||
    first.d.protocol !== MOBILE_PROTOCOL_REVISION ||
    first.d.deviceId !== host.deviceId ||
    first.d.spaceId !== host.spaceId ||
    first.d.memberId !== host.memberId
  )
    return yield* Effect.fail(incompatible());
  // The partition comes from the verified enrollment/session, never from a caller's JSON.
  const hello = { ...first.d, host: { ...first.d.host, id: host.hostId } };
  return {
    route,
    hello,
    expiresAt: session.expires_at * 1000,
    send: (envelope: MobileEnvelope) =>
      Effect.try({
        try: () => {
          const text = JSON.stringify(envelope);
          if (encodeUtf8(text).length > MOBILE_MAX_MESSAGE_BYTES) throw new Error();
          return text;
        },
        catch: () =>
          new RpcFailure(
            "invalid_params",
            "This request is too large or has invalid details.",
            false,
          ),
      }).pipe(Effect.flatMap((text) => socket.send(text).pipe(Effect.mapError(disconnected)))),
    take: receive(true),
  } satisfies ConnectionLink;
});
const dialRoutes = Effect.fn("MobileConnection.dialRoutes")(function* (
  platform: MobilePlatform,
  host: EnrolledHost,
  credential: string,
  sessions: SessionCredentials,
) {
  const owner = yield* Scope.Scope;
  const routes = savedRoutes(host);
  if (!routes.length) return yield* Effect.fail(noRoutes());
  const session = yield* sessions.renew(host, credential);
  return yield* raceRoutes(routes, (route) =>
    Effect.gen(function* () {
      const attempt = yield* Scope.fork(owner);
      return yield* dial(platform, route, host, session, sessions).pipe(
        Scope.provide(attempt),
        Effect.timeoutOrElse({ duration: 16_000, orElse: () => Effect.fail(noRoutes()) }),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Scope.close(attempt, Exit.void) : Effect.void,
        ),
      );
    }),
  );
});
const MAX_RECONNECT_DELAY = 30_000;
export function reconnectDelay(platform: MobilePlatform, failures: number) {
  const jitter = 0.8 + (platform.randomBytes(1)[0] ?? 128) / 640;
  return Math.min(
    MAX_RECONNECT_DELAY,
    Math.max(1_000, Math.round(1_000 * 2 ** Math.min(failures, 5) * jitter)),
  );
}

export const makeConnection = Effect.gen(function* () {
  const platform = yield* Platform;
  const rpc = yield* RpcClient;
  const sessions = yield* makeSessionCredentials(platform);
  const tasks = yield* FiberMap.make<string>();
  const readCatalog = () => {
    const saved = platform.secrets.get(CATALOG_KEY);
    return saved === null ? emptyCatalog() : CatalogSchema.parse(JSON.parse(saved));
  };
  const restored = yield* Effect.try({ try: readCatalog, catch: locked }).pipe(Effect.result);
  let catalogBlocked = restored._tag === "Failure";
  let catalog = restored._tag === "Success" ? restored.success : emptyCatalog();
  const hosts = createProjection({ hosts: catalog.hosts, activeHostId: catalog.activeHostId });
  const state = createProjection<ConnectionState>({ status: "idle", hello: null, message: null });
  let foreground = platform.isForeground();
  let active: ConnectionLink | null = null;
  let pairing = false;
  let hint: RouteFailure | null = null;
  let failures = 0;
  const setState = (
    status: ConnectionState["status"],
    hello: Hello | null = null,
    message: string | null = null,
  ) => state.setState({ status, hello, message }, true);
  const persist = (next: Catalog) =>
    Effect.try({
      try: () => {
        if (catalogBlocked) throw locked();
        platform.secrets.set(CATALOG_KEY, JSON.stringify(next));
        catalog = next;
        hosts.setState({ hosts: next.hosts, activeHostId: next.activeHostId }, true);
      },
      catch: noRoutes,
    });
  const reportFailure = (error: RouteFailure) => {
    if (["incompatible", "revoked", "pin"].includes(error.code)) hint = error;
    const condition = hint ?? error;
    setState(
      condition.code === "revoked"
        ? "revoked"
        : condition.code === "incompatible"
          ? "incompatible"
          : condition.code === "pin"
            ? "unavailable"
            : "offline",
      null,
      condition.message,
    );
  };
  const serve = Effect.fn("MobileConnection.serve")(function* (link: ConnectionLink) {
    active = link;
    failures = 0;
    hint = null;
    yield* rpc.attach(link.send);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (active === link) active = null;
        yield* rpc.disconnect;
      }),
    );
    const pongs = yield* Queue.sliding<void>(1);
    yield* Effect.addFinalizer(() => Queue.shutdown(pongs));
    setState("connected", link.hello);
    const ingress = Effect.gen(function* () {
      while (true) {
        const envelope = yield* link.take;
        if (envelope === "renew") return;
        if (envelope === "dropped") yield* rpc.dropEvent;
        else if (envelope.t === "ping") yield* link.send({ t: "pong" });
        else if (envelope.t === "pong") yield* Queue.offer(pongs, undefined);
        else yield* rpc.receive(envelope);
      }
    });
    const heartbeat = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(20_000);
        if (!foreground) return yield* Effect.never;
        yield* Queue.clear(pongs);
        yield* link.send({ t: "ping" });
        yield* Queue.take(pongs).pipe(
          Effect.timeoutOrElse({
            duration: 10_000,
            orElse: () => (foreground ? Effect.fail(noRoutes()) : Effect.never),
          }),
        );
      }
    });
    // Renew with the Device credential, exactly as desktop sessions do, before the old session expires.
    const renew = Effect.sleep(Math.max(1_000, link.expiresAt - platform.now() - 60_000));
    return yield* Effect.raceFirst(Effect.raceFirst(ingress, heartbeat), renew).pipe(
      Effect.mapError((e) => (e instanceof RouteFailure ? e : noRoutes())),
    );
  });
  const connectAttempt = (enrollment?: EnrolledHost) => {
    let pending = enrollment;
    return Effect.scoped(
      Effect.gen(function* () {
        const host = pending ?? catalog.hosts.find((item) => item.hostId === catalog.activeHostId);
        if (!host || !foreground) return yield* Effect.never;
        const credential = catalog.credentials[host.hostId];
        if (!credential) return yield* Effect.fail(revoked());
        if (!hint && failures === 0 && state.getState().status === "idle") setState("connecting");
        const link = yield* dialRoutes(platform, host, credential, sessions);
        const learned = {
          ...host,
          hostName: link.hello.host.name,
          spaceKind: link.hello.spaceKind,
          lastConnectedRoute: link.route,
          routes: uniqueRoutes([...link.hello.routes, link.route]),
        };
        yield* persist({
          ...catalog,
          hosts: catalog.hosts.some((item) => item.hostId === host.hostId)
            ? catalog.hosts.map((item) => (item.hostId === host.hostId ? learned : item))
            : [...catalog.hosts, learned],
          activeHostId: host.hostId,
        });
        pending = undefined;
        yield* serve(link);
      }),
    );
  };
  const connectOnce = (enrollment?: EnrolledHost) =>
    connectAttempt(enrollment).pipe(
      Effect.forever,
      Effect.catch((error) => {
        reportFailure(error);
        return error.code === "revoked" || error.code === "pin" || !foreground
          ? Effect.never
          : Effect.fail(error);
      }),
      Effect.retry(
        Schedule.spaced(1_000).pipe(
          Schedule.modifyDelay(() => Effect.sync(() => reconnectDelay(platform, failures++))),
        ),
      ),
    );
  const reconnectNow = Effect.fnUntraced(function* (enrollment?: EnrolledHost) {
    yield* FiberMap.remove(tasks, "connection");
    if (catalogBlocked) {
      const restored = yield* Effect.try({ try: readCatalog, catch: locked }).pipe(Effect.result);
      if (restored._tag === "Failure") {
        setState("unavailable", null, restored.failure.message);
        return;
      }
      catalog = restored.success;
      catalogBlocked = false;
      hosts.setState({ hosts: catalog.hosts, activeHostId: catalog.activeHostId }, true);
    }
    failures = 0;
    if (!hint) setState(catalog.activeHostId ? "offline" : "idle");
    if ((enrollment || catalog.activeHostId) && foreground)
      yield* FiberMap.run(tasks, "connection", connectOnce(enrollment), { startImmediately: true });
  });
  const pairWithUri = Effect.fn("MobileConnection.linkDevice")(function* (uri: string) {
    if (catalogBlocked) return yield* Effect.fail(locked());
    const offer = parseDeviceLinkUri(uri);
    if (!offer)
      return yield* Effect.fail(new RouteFailure("invalid", "This is not a Nodex device link."));
    if (offer.expires_at * 1000 <= platform.now())
      return yield* Effect.fail(
        new RouteFailure(
          "expired",
          "This link expired. Show a new device link in the Space’s settings.",
        ),
      );
    if (pairing)
      return yield* Effect.fail(new RouteFailure("busy", "A device link is already being opened."));
    if (!foreground) return yield* Effect.fail(noRoutes());
    pairing = true;
    const enroll = Effect.gen(function* () {
      let lastFailure = noRoutes();
      for (const route of orderRoutes(uniqueRoutes(offer.routes))) {
        const result = yield* request(
          platform,
          route,
          offer.fingerprint,
          "/enroll",
          {
            code: offer.code,
            device_label: platform.deviceName,
            display_name: platform.deviceName,
            form_factor: "phone",
          },
          EnrollmentSchema,
        ).pipe(Effect.result);
        if (result._tag === "Failure") {
          lastFailure = result.failure;
          if (lastFailure.code !== "unreachable") return yield* Effect.fail(lastFailure);
          continue;
        }
        const enrolled = result.success;
        if (enrolled.space_id !== offer.space_id || enrolled.member_id !== offer.member_id)
          return yield* Effect.fail(incompatible());
        const host: EnrolledHost = {
          hostId: spaceMemberKey(enrolled.space_id, enrolled.member_id),
          hostName: enrolled.space_name,
          spaceId: enrolled.space_id,
          memberId: enrolled.member_id,
          fingerprint: offer.fingerprint,
          routes: uniqueRoutes(offer.routes),
          pairedAt: platform.now(),
          deviceId: enrolled.device_id,
          lastConnectedRoute: route,
        };
        yield* FiberMap.remove(tasks, "connection");
        // The one-time credential is durably private before any content connection is attempted.
        yield* persist({
          ...catalog,
          credentials: { ...catalog.credentials, [host.hostId]: enrolled.device_credential },
        });
        hint = null;
        yield* reconnectNow(host);
        const connected = () =>
          state.getState().status === "connected" && active?.hello.host.id === host.hostId;
        if (!connected()) {
          yield* state.changes.pipe(
            Stream.filter(
              (current) =>
                current.status === "connected" ||
                current.status === "incompatible" ||
                current.status === "unavailable" ||
                current.status === "revoked",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.timeoutOrElse({ duration: 16_000, orElse: () => Effect.fail(noRoutes()) }),
          );
        }
        const saved = catalog.hosts.find((item) => item.hostId === host.hostId);
        if (!connected() || !saved) return yield* Effect.fail(hint ?? incompatible());
        return saved;
      }
      return yield* Effect.fail(lastFailure);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pairing = false;
        }),
      ),
    );
    const fiber = yield* FiberMap.run(tasks, "pairing", enroll, { startImmediately: true });
    return yield* Fiber.join(fiber);
  });
  yield* platform.foregroundChanges.pipe(
    Stream.runForEach((next) =>
      Effect.gen(function* () {
        if (foreground === next) return;
        foreground = next;
        if (next) {
          yield* reconnectNow();
          return;
        }
        yield* FiberMap.remove(tasks, "pairing");
        yield* FiberMap.remove(tasks, "connection");
        if (catalog.activeHostId) setState("offline", null, state.getState().message);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* reconnectNow();
  return {
    hosts,
    state,
    rpc,
    pairWithUri,
    reconnectNow: reconnectNow(),
    activateHost: Effect.fnUntraced(function* (hostId: string) {
      if (catalog.activeHostId === hostId || !catalog.hosts.some((host) => host.hostId === hostId))
        return;
      yield* FiberMap.remove(tasks, "connection");
      hint = null;
      setState("offline");
      yield* persist({ ...catalog, activeHostId: hostId });
      yield* reconnectNow();
    }),
    forgetHost: Effect.fnUntraced(function* (hostId: string) {
      if (!catalog.hosts.some((host) => host.hostId === hostId)) return;
      const remaining = catalog.hosts.filter((host) => host.hostId !== hostId);
      const credentials = { ...catalog.credentials };
      delete credentials[hostId];
      sessions.invalidate(hostId);
      const wasActive = catalog.activeHostId === hostId;
      if (wasActive) {
        yield* FiberMap.remove(tasks, "connection");
        hint = null;
        setState(remaining.length ? "offline" : "idle");
      }
      yield* persist({
        ...catalog,
        hosts: remaining,
        credentials,
        activeHostId: wasActive ? (remaining[0]?.hostId ?? null) : catalog.activeHostId,
      });
      if (wasActive) yield* reconnectNow();
    }),
    activeLink: () => (foreground ? active : null),
    activeHostId: () => catalog.activeHostId,
    requireLink: Effect.suspend(() =>
      foreground && active ? Effect.succeed(active) : Effect.fail(disconnected()),
    ),
    assertLink: (link: ConnectionLink) =>
      foreground && active === link ? Effect.void : Effect.fail(disconnected()),
  };
});
export type MobileConnection = Effect.Success<typeof makeConnection>;
export class Connection extends Context.Service<Connection, MobileConnection>()(
  "nodex/mobile/Connection",
) {}
