import {
  beginHandshake,
  CHANNEL_CLOSE,
  CHANNEL_MAX_MESSAGE_BYTES,
  generateStaticKeyPair,
  MOBILE_PROTOCOL_REVISION,
  MobileEnvelopeSchema,
  NOISE_KEY_BYTES,
  parsePairingUri,
  type Hello,
  type MobileEnvelope,
  type StaticKeyPair,
} from "@nodex/mobile-protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { createProjection } from "./projection";
import { openSocket } from "./socket";
import { Platform } from "./platform";
import { decodeUtf8, encodeUtf8, fromBase64Url } from "./encoding";
import type { MobilePlatform } from "./platform";
import { readStored } from "./storage";
import { RpcClient, disconnected, RpcFailure } from "./rpc-client";

export type SavedHost = {
  hostId: string;
  hostName: string;
  hostKey: string;
  routes: string[];
  pairedAt: number;
  deviceId: string;
  lastConnectedRoute: string | null;
};

export type ConnectionState = {
  status: "idle" | "connecting" | "connected" | "offline" | "incompatible" | "revoked";
  hello: Hello | null;
  message: string | null;
};

type PairFailureCode = "invalid" | "expired" | "rejected" | "unreachable" | "incompatible" | "busy";
type RouteFailureCode = PairFailureCode | "revoked";

class RouteFailure extends Error {
  constructor(
    readonly code: RouteFailureCode,
    message: string,
    readonly authenticated = false,
  ) {
    super(message);
    this.name = "RouteFailure";
  }
}

class PairingFailure extends Error {
  constructor(
    readonly code: PairFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "PairingFailure";
  }
}

const expiredPairing = () =>
  new PairingFailure("expired", "This pairing code expired. Show a new one on your desktop.");

type SavedIdentity = { publicKey: string; secretKey: string };
type PendingPairing = {
  hostKey: string;
  routes: string[];
  pairedAt: number;
  identity: SavedIdentity;
};
type Catalog = {
  hosts: SavedHost[];
  activeHostId: string | null;
  identities: Record<string, SavedIdentity>;
  pendingPairing?: PendingPairing;
};

type HandshakeOptions = {
  hostKey: Uint8Array;
  device: StaticKeyPair;
  psk?: Uint8Array;
  expected?: SavedHost;
  beforePairingPing?: Effect.Effect<void, RouteFailure>;
};

export type ConnectionLink = {
  route: string;
  hello: Hello;
  send(envelope: MobileEnvelope): Effect.Effect<void, RpcFailure>;
  take: Effect.Effect<MobileEnvelope | "dropped", RouteFailure>;
};

const CATALOG_KEY = "nodex.mobile.hosts.v1";
const noRoutes = () => new RouteFailure("unreachable", "Could not reach your desktop.");
const incompatible = (authenticated = false) =>
  new RouteFailure(
    "incompatible",
    "Update Nodex here or on your desktop to connect.",
    authenticated,
  );
const revoked = () =>
  new RouteFailure("revoked", "Your desktop no longer knows this phone. Pair it again.");
const rejected = () => new RouteFailure("rejected", "Your desktop turned this pairing code down.");

function decodeIdentity(identity: SavedIdentity): StaticKeyPair {
  return {
    publicKey: hexToBytes(identity.publicKey),
    secretKey: hexToBytes(identity.secretKey),
  };
}

function routeFailure(code: number) {
  if (code === CHANNEL_CLOSE.protocolMismatch) return incompatible();
  if (code === CHANNEL_CLOSE.revoked || code === CHANNEL_CLOSE.unknownDevice) return revoked();
  if (code === CHANNEL_CLOSE.pairingRejected) return rejected();
  return noRoutes();
}

function uniqueRoutes(routes: string[]) {
  return [
    ...new Set(
      routes.filter((route) => {
        try {
          const url = new URL(route);
          return (
            (url.protocol === "ws:" || url.protocol === "wss:") &&
            !url.username &&
            !url.password &&
            !url.hash &&
            !!url.hostname
          );
        } catch {
          return false;
        }
      }),
    ),
  ];
}

/** Acquired in the attempt Scope, which is retained only for the winning route. */
const dial = Effect.fn("MobileConnection.dial")(function* (
  platform: MobilePlatform,
  route: string,
  options: HandshakeOptions,
) {
  const socket = yield* openSocket(platform, route).pipe(Effect.mapError(() => noRoutes()));
  const take = socket.take.pipe(Effect.mapError(() => noRoutes()));
  const first = yield* take;
  if (first.type !== "open")
    return yield* Effect.fail(first.type === "closed" ? routeFailure(first.code) : noRoutes());
  const handshake = yield* Effect.try({
    try: () =>
      beginHandshake({
        hostPublicKey: options.hostKey,
        device: options.device,
        psk: options.psk,
        payload: encodeUtf8(
          JSON.stringify({
            protocol: MOBILE_PROTOCOL_REVISION,
            deviceName: platform.deviceName,
            platform: platform.platform,
            appVersion: platform.appVersion,
          }),
        ),
        randomBytes: platform.randomBytes,
      }),
    catch: () => noRoutes(),
  });
  yield* socket.send(handshake.message).pipe(Effect.mapError(() => noRoutes()));
  const reply = yield* take;
  if (reply.type !== "frame")
    return yield* Effect.fail(reply.type === "closed" ? routeFailure(reply.code) : noRoutes());
  const secure = yield* Effect.try({
    try: () => handshake.finish(reply.bytes).channel,
    catch: () => (options.psk ? rejected() : noRoutes()),
  });
  const writer = yield* Semaphore.make(1);
  const sendEnvelope = Effect.fnUntraced(function* (envelope: MobileEnvelope) {
    const message = yield* Effect.try({
      try: () => encodeUtf8(JSON.stringify(envelope)),
      catch: () => new RpcFailure("invalid_params", "This request has invalid details.", false),
    });
    if (message.length > CHANNEL_MAX_MESSAGE_BYTES)
      return yield* Effect.fail(
        new RpcFailure("invalid_params", "This request is too large to send.", false),
      );
    const frames = yield* Effect.try({ try: () => secure.seal(message), catch: disconnected });
    for (const frame of frames) yield* socket.send(frame).pipe(Effect.mapError(disconnected));
  });
  // Sealing consumes frame sequence numbers. Publish that whole message before another writer.
  const send = (envelope: MobileEnvelope) =>
    writer.withPermits(1)(sendEnvelope(envelope).pipe(Effect.uninterruptible));
  yield* options.beforePairingPing ?? Effect.void;
  yield* send({ t: "ping" }).pipe(Effect.mapError(() => noRoutes()));
  const receive = Effect.fnUntraced(function* (
    ready: boolean,
  ): Effect.fn.Return<MobileEnvelope | "dropped", RouteFailure> {
    while (true) {
      const event = yield* take;
      if (event.type === "closed") return yield* Effect.fail(routeFailure(event.code));
      if (event.type !== "frame") continue;
      const bytes = yield* Effect.try({
        try: () => secure.open(event.bytes),
        catch: () => noRoutes(),
      });
      if (bytes === null) continue;
      const json = yield* Effect.try({
        try: (): unknown => JSON.parse(decodeUtf8(bytes)),
        catch: () => incompatible(),
      }).pipe(Effect.result);
      if (json._tag === "Failure") {
        if (!ready) return yield* Effect.fail(json.failure);
        continue;
      }
      const parsed = MobileEnvelopeSchema.safeParse(json.success);
      if (parsed.success) return parsed.data;
      if (!ready) return yield* Effect.fail(incompatible());
      const data = json.success;
      if (data !== null && typeof data === "object" && "t" in data && data.t === "evt")
        return "dropped";
    }
  });
  const envelope = yield* receive(false);
  if (envelope === "dropped" || envelope.t !== "hello") return yield* Effect.fail(incompatible());
  const hello = envelope.d;
  if (hello.protocol !== MOBILE_PROTOCOL_REVISION) return yield* Effect.fail(incompatible(true));
  if (
    options.expected &&
    (hello.host.id !== options.expected.hostId || hello.deviceId !== options.expected.deviceId)
  )
    return yield* Effect.fail(noRoutes());
  return { route, hello, send, take: receive(true) } satisfies ConnectionLink;
});

const raceRoutes = Effect.fn("MobileConnection.raceRoutes")(function* (
  platform: MobilePlatform,
  routes: string[],
  options: HandshakeOptions,
) {
  if (!routes.length) return yield* Effect.fail(noRoutes());
  const owner = yield* Scope.Scope;
  const failures: RouteFailure[] = [];
  return yield* Effect.raceAll(
    routes.map((route, index) =>
      Effect.gen(function* () {
        if (index) yield* Effect.sleep(index * 250);
        const attempt = yield* Scope.fork(owner);
        return yield* dial(platform, route, options).pipe(
          Scope.provide(attempt),
          Effect.timeoutOrElse({ duration: 8_000, orElse: () => Effect.fail(noRoutes()) }),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(attempt, Exit.void) : Effect.void,
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              failures.push(error);
            }),
          ),
        );
      }),
    ),
  ).pipe(
    Effect.catch(() =>
      Effect.fail(
        failures.find((failure) => failure.authenticated) ??
          ["incompatible", "revoked", "rejected"]
            .map((code) => failures.find((failure) => failure.code === code))
            .find((error) => error !== undefined) ??
          noRoutes(),
      ),
    ),
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
  const owner = yield* Scope.Scope;
  const tasks = yield* FiberMap.make<string>();
  let catalog = readStored<Catalog>(platform.secrets, CATALOG_KEY, {
    hosts: [],
    activeHostId: null,
    identities: {},
  });
  const hosts = createProjection({ hosts: catalog.hosts, activeHostId: catalog.activeHostId });
  const state = createProjection<ConnectionState>({ status: "idle", hello: null, message: null });
  let foreground = platform.isForeground();
  let active: ConnectionLink | null = null;
  let pairing = false;
  let recovering = false;
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
        platform.secrets.set(CATALOG_KEY, JSON.stringify(next));
        catalog = next;
        hosts.setState({ hosts: next.hosts, activeHostId: next.activeHostId }, true);
      },
      catch: () => noRoutes(),
    });
  const replaceHost = (host: SavedHost) =>
    catalog.hosts.some((item) => item.hostId === host.hostId)
      ? catalog.hosts.map((item) => (item.hostId === host.hostId ? host : item))
      : [...catalog.hosts, host];
  const learnedHost = (link: ConnectionLink, hostKey: string, pairedAt: number): SavedHost => ({
    hostId: link.hello.host.id,
    hostName: link.hello.host.name,
    hostKey,
    routes: uniqueRoutes([...link.hello.routes, link.route]),
    pairedAt,
    deviceId: link.hello.deviceId,
    lastConnectedRoute: link.route,
  });
  const reportFailure = (error: RouteFailure) => {
    if (
      (error.code === "incompatible" || error.code === "revoked") &&
      (!hint?.authenticated || error.authenticated)
    )
      hint = error;
    setState(
      hint?.code === "incompatible" || hint?.code === "revoked" ? hint.code : "offline",
      null,
      (hint ?? error).message,
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
    const paused = platform.foregroundChanges.pipe(
      Stream.filter((value) => !value),
      Stream.take(1),
      Stream.runDrain,
    );
    const foregroundHeartbeat = Effect.raceFirst(heartbeat, paused).pipe(
      Effect.andThen(Effect.never),
    );
    return yield* Effect.raceFirst(ingress, foregroundHeartbeat).pipe(
      Effect.mapError((error) => (error instanceof RouteFailure ? error : noRoutes())),
    );
  });
  const retryPolicy = Schedule.spaced(1_000).pipe(
    Schedule.modifyDelay(() =>
      Effect.sync(() =>
        hint?.authenticated ? MAX_RECONNECT_DELAY : reconnectDelay(platform, failures++),
      ),
    ),
  );
  const connectOnce = Effect.scoped(
    Effect.gen(function* () {
      const host = catalog.hosts.find((item) => item.hostId === catalog.activeHostId);
      if (!host || !foreground) return yield* Effect.never;
      const identity = catalog.identities[host.hostId];
      if (!identity) {
        setState("revoked", null, revoked().message);
        return yield* Effect.never;
      }
      // A retry is still offline: what the person is told holds steady until the Host answers.
      if (!hint && failures === 0) setState("connecting");
      const link = yield* raceRoutes(
        platform,
        uniqueRoutes([
          ...(host.lastConnectedRoute ? [host.lastConnectedRoute] : []),
          ...host.routes,
        ]),
        {
          hostKey: fromBase64Url(host.hostKey),
          device: decodeIdentity(identity),
          expected: host,
        },
      );
      const learned = learnedHost(link, host.hostKey, host.pairedAt);
      if (JSON.stringify(learned) !== JSON.stringify(host))
        yield* persist({ ...catalog, hosts: replaceHost(learned) });
      yield* serve(link);
    }),
  ).pipe(
    Effect.catch((error) => {
      reportFailure(error);
      return foreground ? Effect.fail(error) : Effect.never;
    }),
    Effect.retry(retryPolicy),
  );
  const reconnectNow = Effect.gen(function* () {
    yield* FiberMap.remove(tasks, "connection");
    failures = 0;
    if (!hint) setState(catalog.activeHostId ? "offline" : "idle");
    if (catalog.activeHostId && foreground)
      yield* FiberMap.run(tasks, "connection", connectOnce, { startImmediately: true });
  });
  const completePairing = Effect.fnUntraced(function* (
    link: ConnectionLink,
    pending: PendingPairing,
    session: Scope.Closeable,
  ) {
    yield* FiberMap.remove(tasks, "connection");
    const host = learnedHost(link, pending.hostKey, pending.pairedAt);
    hint = null;
    failures = 0;
    yield* persist({
      hosts: replaceHost(host),
      activeHostId: host.hostId,
      identities: { ...catalog.identities, [host.hostId]: pending.identity },
    });
    // The winning socket outlives the pairing command and is owned by the connection lane.
    const adopted = serve(link).pipe(
      Scope.provide(session),
      Effect.onExit(() => Scope.close(session, Exit.void)),
      Effect.catch((error) =>
        Effect.gen(function* () {
          reportFailure(error);
          if (!foreground) return yield* Effect.never;
          yield* Effect.sleep(
            hint?.authenticated ? MAX_RECONNECT_DELAY : reconnectDelay(platform, failures++),
          );
          return yield* connectOnce;
        }),
      ),
    );
    yield* FiberMap.run(tasks, "connection", adopted, { startImmediately: true });
    return host;
  });
  const recoverPairing = (pending: PendingPairing) =>
    raceRoutes(platform, pending.routes, {
      hostKey: fromBase64Url(pending.hostKey),
      device: decodeIdentity(pending.identity),
    });
  const clearPending = (pending: PendingPairing) =>
    Effect.suspend(() => {
      if (catalog.pendingPairing !== pending) return Effect.void;
      const { pendingPairing: _, ...next } = catalog;
      return persist(next).pipe(Effect.ignore);
    });
  // Close hints can cost an unfinished pairing, but a network failure must never cost its key.
  const clearRefusedPending = (pending: PendingPairing, error: RouteFailure) =>
    error.code === "revoked" || error.code === "rejected" ? clearPending(pending) : Effect.void;
  const recoverOnLaunch = Effect.gen(function* () {
    const pending = catalog.pendingPairing;
    if (!pending || pairing || !foreground) return;
    pairing = true;
    recovering = true;
    yield* FiberMap.run(
      tasks,
      "pairing",
      Effect.gen(function* () {
        const session = yield* Scope.fork(owner);
        let transferred = false;
        yield* recoverPairing(pending).pipe(
          Scope.provide(session),
          Effect.flatMap((link) => completePairing(link, pending, session)),
          Effect.tap(() =>
            Effect.sync(() => {
              transferred = true;
            }),
          ),
          Effect.catch((error) => clearRefusedPending(pending, error)),
          Effect.ensuring(
            Effect.gen(function* () {
              pairing = false;
              recovering = false;
              if (!transferred) yield* Scope.close(session, Exit.void);
            }),
          ),
        );
      }),
      { startImmediately: true },
    );
  });
  const pairWithUri = Effect.fn("MobileConnection.pairWithUri")(function* (uri: string) {
    const offer = parsePairingUri(uri);
    if (!offer)
      return yield* Effect.fail(new PairingFailure("invalid", "This is not a Nodex pairing code."));
    if (offer.expiresAt <= platform.now() && catalog.pendingPairing?.hostKey !== offer.hostKey)
      return yield* Effect.fail(expiredPairing());
    const routes = uniqueRoutes(offer.routes);
    const keys = yield* Effect.try({
      try: () => {
        const hostKey = fromBase64Url(offer.hostKey);
        const psk = fromBase64Url(offer.secret);
        if (!routes.length || hostKey.length !== NOISE_KEY_BYTES || psk.length !== NOISE_KEY_BYTES)
          throw new Error();
        return { hostKey, psk };
      },
      catch: () => new PairingFailure("invalid", "This Nodex pairing code is invalid."),
    });
    // What a person just chose takes over from a recovery running on its own.
    if (recovering) yield* FiberMap.remove(tasks, "pairing");
    if (pairing)
      return yield* Effect.fail(new PairingFailure("busy", "Pairing is already in progress."));
    if (!foreground)
      return yield* Effect.fail(new PairingFailure("unreachable", noRoutes().message));
    pairing = true;
    const operation = Effect.gen(function* () {
      const session = yield* Scope.fork(owner);
      let transferred = false;
      return yield* Effect.gen(function* () {
        const saved = catalog.pendingPairing;
        if (saved?.hostKey === offer.hostKey) {
          const pending = { ...saved, routes: uniqueRoutes([...routes, ...saved.routes]) };
          yield* persist({ ...catalog, pendingPairing: pending });
          const recovered = yield* recoverPairing(pending).pipe(Effect.result);
          if (recovered._tag === "Success")
            return yield* completePairing(recovered.success, pending, session);
          yield* clearRefusedPending(pending, recovered.failure);
          if (catalog.pendingPairing === pending) return yield* Effect.fail(recovered.failure);
        } else if (saved) {
          yield* clearPending(saved);
        }
        if (offer.expiresAt <= platform.now()) return yield* Effect.fail(expiredPairing());
        const device = generateStaticKeyPair(platform.randomBytes);
        const pending: PendingPairing = {
          hostKey: offer.hostKey,
          routes,
          pairedAt: platform.now(),
          identity: {
            publicKey: bytesToHex(device.publicKey),
            secretKey: bytesToHex(device.secretKey),
          },
        };
        return yield* raceRoutes(platform, routes, {
          ...keys,
          device,
          beforePairingPing: Effect.suspend(() =>
            catalog.pendingPairing === pending
              ? Effect.void
              : persist({ ...catalog, pendingPairing: pending }),
          ),
        }).pipe(
          Effect.catch((original) =>
            catalog.pendingPairing === pending
              ? recoverPairing(pending).pipe(
                  Effect.tapError((error) => clearRefusedPending(pending, error)),
                  Effect.catch(() => Effect.fail(original)),
                )
              : Effect.fail(original),
          ),
          Effect.flatMap((link) => completePairing(link, pending, session)),
          Effect.tapError((error) => clearRefusedPending(pending, error)),
        );
      }).pipe(
        Scope.provide(session),
        Effect.tap(() =>
          Effect.sync(() => {
            transferred = true;
          }),
        ),
        Effect.mapError(
          (error) =>
            new PairingFailure(error.code === "revoked" ? "rejected" : error.code, error.message),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            pairing = false;
            if (!transferred) yield* Scope.close(session, Exit.void);
          }),
        ),
      );
    });
    const fiber = yield* FiberMap.run(tasks, "pairing", operation, { startImmediately: true });
    return yield* Fiber.join(fiber);
  });
  yield* platform.foregroundChanges.pipe(
    Stream.runForEach((next) =>
      Effect.gen(function* () {
        if (foreground === next) return;
        foreground = next;
        if (next) {
          yield* reconnectNow;
          yield* recoverOnLaunch;
          return;
        }
        if (!active) {
          yield* FiberMap.remove(tasks, "connection");
          if (state.getState().status === "connecting") setState("offline");
        }
        yield* FiberMap.remove(tasks, "pairing");
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* reconnectNow;
  yield* recoverOnLaunch;
  return {
    hosts,
    state,
    rpc,
    pairWithUri,
    reconnectNow,
    activateHost: Effect.fnUntraced(function* (hostId: string) {
      if (catalog.activeHostId === hostId || !catalog.hosts.some((host) => host.hostId === hostId))
        return;
      yield* FiberMap.remove(tasks, "connection");
      setState("offline");
      hint = null;
      yield* persist({ ...catalog, activeHostId: hostId });
      yield* reconnectNow;
    }),
    forgetHost: Effect.fnUntraced(function* (hostId: string) {
      if (!catalog.hosts.some((host) => host.hostId === hostId)) return;
      const remaining = catalog.hosts.filter((host) => host.hostId !== hostId);
      const identities = { ...catalog.identities };
      delete identities[hostId];
      const wasActive = catalog.activeHostId === hostId;
      if (wasActive) {
        yield* FiberMap.remove(tasks, "connection");
        setState(remaining.length ? "offline" : "idle");
        hint = null;
      }
      yield* persist({
        ...catalog,
        hosts: remaining,
        identities,
        activeHostId: wasActive ? (remaining[0]?.hostId ?? null) : catalog.activeHostId,
      });
      if (wasActive) yield* reconnectNow;
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
