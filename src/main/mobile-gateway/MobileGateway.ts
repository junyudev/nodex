import {
  PUSH_KEY_BYTES,
  PushRegistrationSchema,
  decodePushKey,
  type PushRegistration,
  CHANNEL_CLOSE,
  CHANNEL_HANDSHAKE_PAIR,
  CHANNEL_MAX_MESSAGE_BYTES,
  MOBILE_PROTOCOL_REVISION,
  MobileEnvelopeSchema,
  encodePairingUri,
  generateStaticKeyPair,
  respondToHandshake,
  type MobileEnvelope,
  type RpcError,
  type StaticKeyPair,
} from "@nodex/mobile-protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { z } from "zod";
import type { MobileAccessStatus, MobileDevice } from "../../shared/mobile-access";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { MainConfig } from "../app/MainConfig";
import { MobileProfileFiles } from "../platform/node/MobileProfileFiles";
import { listenMobileSocket, type MobileSocket } from "../platform/node/MobileSocket";
import { SecretEncryption } from "../platform/SecretEncryption";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { isPrivateMobilePeer, mobileHostName, mobileRoutes } from "./routes";
import { makePushDelivery } from "./push-delivery";
import { MobilePushEvents } from "./push-events";
import {
  invalid,
  internal,
  invokeMobileRpc,
  MobileRpc,
  unavailable,
  type PushMobileEvent,
} from "./rpc";

type MobileStatusEffect = Effect.Effect<MobileAccessStatus>;
export class MobileGateway extends Context.Service<
  MobileGateway,
  {
    readonly status: MobileStatusEffect;
    readonly changes: Stream.Stream<void>;
    readonly setEnabled: (enabled: boolean) => MobileStatusEffect;
    readonly beginPairing: MobileStatusEffect;
    readonly cancelPairing: MobileStatusEffect;
    readonly revoke: (deviceId: string) => MobileStatusEffect;
  }
>()("nodex/main/mobile-gateway/MobileGateway") {}

const PAIRING_LIFETIME = 5 * 60_000;
const HANDSHAKE_TIMEOUT = "10 seconds";
const IDLE_MILLIS = 60_000;
const UNAUTHENTICATED_LIMIT = 8;
const CHANNEL_LIMIT = 24;
const DEVICE_CHANNEL_LIMIT = 2;
const DEVICE_LIMIT = 32;
const LAST_SEEN_INTERVAL = 30_000;
const EVENT_CAPACITY = 128;
const REQUEST_CONCURRENCY = 8;
const REQUEST_LIMIT = 32;
/** Open and close must apply in the order the phone sent them, however long a read takes. */
const CHAT_LIFECYCLE_METHODS: ReadonlySet<string> = new Set(["chat.open", "chat.close"]);
/**
 * The phone has stopped waiting by now, so a slot still held would only starve what it can still
 * use, such as the Inbox while Agent execution is too busy to answer.
 */
const ABANDONED_REQUEST_MILLIS = 30_000;
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const storedDevice = z.object({
  id: z.string(),
  key: keySchema,
  name: z.string().max(80),
  platform: z.string().max(32),
  appVersion: z.string().max(32),
  pairedAt: z.number(),
  lastSeenAt: z.number().nullable(),
  push: PushRegistrationSchema.optional(),
});
const storedProfile = z.object({
  publicKey: keySchema,
  secretKey: keySchema,
  port: z.number().int().min(0).max(65_535),
  devices: z.array(storedDevice).max(DEVICE_LIMIT),
});
const encryptedProfile = z.object({ encrypted: z.string() });
const phonePayload = z.object({
  protocol: z.number().int(),
  deviceName: z.string().max(256),
  platform: z.string().max(128),
  appVersion: z.string().max(128),
});
type StoredProfile = z.infer<typeof storedProfile>;
type StoredDevice = z.infer<typeof storedDevice>;
type Offer = { secret: Buffer; expiresAt: number };
type Close = (code: number) => void;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encodeKey = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sanitize = (text: string, max: number) =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/u, "");
const parseJson = (bytes: Uint8Array): unknown => JSON.parse(utf8.decode(bytes));
class MobileProfileFailure extends Data.TaggedError("MobileProfileFailure")<{
  readonly message: string;
}> {}
const failure = (message: string) => new MobileProfileFailure({ message });

const freshProfile = (host: StaticKeyPair): StoredProfile => ({
  publicKey: encodeKey(host.publicKey),
  secretKey: encodeKey(host.secretKey),
  port: 0,
  devices: [],
});

export const make = Effect.gen(function* () {
  const config = yield* MainConfig;
  const files = yield* MobileProfileFiles;
  const settings = yield* ApplicationSettings;
  const secrets = yield* SecretEncryption;
  const rpc = yield* MobileRpc;
  const pushEvents = yield* MobilePushEvents;
  const clock = yield* Clock.Clock;
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const hostName = sanitize(mobileHostName(files.hostName()), 80) || "Nodex";
  const now = () => clock.currentTimeMillisUnsafe();
  const recent = new Map<string, number>();
  let nextLastSeenWrite = 0;
  const connected = new Map<string, Set<Close>>();
  const tick = yield* SubscriptionRef.make(0);
  let listener: Scope.Closeable | null = null;
  let profile: StoredProfile | null = null;
  let offer: Offer | null = null;
  let enabled = false;
  let state: MobileAccessStatus["state"] = "off";
  let failureMessage: string | null = null;
  let pending = 0;
  let total = 0;

  const routes = () =>
    state === "listening" && profile
      ? mobileRoutes(files.networkInterfaces(), profile.port, !config.isPackaged)
      : [];
  const status = Effect.sync((): MobileAccessStatus => {
    const currentRoutes = routes();
    const pairing =
      offer && offer.expiresAt > now() && profile && currentRoutes.length
        ? {
            uri: encodePairingUri({
              hostKey: profile.publicKey,
              hostName,
              secret: encodeKey(offer.secret),
              routes: [...currentRoutes],
              expiresAt: offer.expiresAt,
            }),
            expiresAt: offer.expiresAt,
          }
        : null;
    return {
      enabled,
      state,
      failureMessage,
      hostName,
      routes: currentRoutes,
      devices: (profile?.devices ?? []).map(({ key: _key, push, ...device }): MobileDevice => ({
        ...device,
        lastSeenAt: recent.get(device.id) ?? device.lastSeenAt,
        connected: Boolean(connected.get(device.id)?.size),
        notificationsEnabled: Boolean(
          push && (push.preferences.needsYou || push.preferences.finished),
        ),
      })),
      pairing,
    };
  });
  const publish = SubscriptionRef.update(tick, (n) => n + 1);
  const clearOffer = () => {
    offer?.secret.fill(0);
    offer = null;
  };
  yield* Effect.addFinalizer(() => Effect.sync(clearOffer));
  const setFailure = (message: string) => {
    state = "failed";
    failureMessage = message;
  };

  const readProfile = Effect.gen(function* () {
    const stored = yield* files.read(config.nodexHome);
    if (stored === null) return null;
    if (!secrets.isAvailable())
      return yield* failure("Unlock this device’s secure storage to enable Mobile Access.");
    return yield* Effect.try({
      try: () => {
        const { encrypted } = encryptedProfile.parse(JSON.parse(stored));
        return storedProfile.parse(
          JSON.parse(secrets.decryptString(Buffer.from(encrypted, "base64"))),
        );
      },
      catch: () => failure("Mobile Access could not open its private Profile data."),
    });
  });

  const persist = Effect.fn("MobileGateway.persist")(function* (next: StoredProfile) {
    const encrypted = yield* Effect.try({
      try: () => {
        if (!secrets.isAvailable()) throw new Error();
        return secrets.encryptString(JSON.stringify(next)).toString("base64");
      },
      catch: () => failure("Mobile Access could not save to secure storage."),
    });
    yield* files.write(config.nodexHome, encrypted);
    profile = next;
  });

  const updatePush = (deviceId: string, registration: PushRegistration | undefined) =>
    mutex.withPermit(
      Effect.gen(function* () {
        if (!profile || !enabled || !profile.devices.some((device) => device.id === deviceId))
          return yield* Effect.fail(unavailable("This phone is no longer connected."));
        const devices = profile.devices.map((device) => {
          if (device.id !== deviceId) return device;
          const { push: _push, ...rest } = device;
          return registration ? { ...rest, push: registration } : rest;
        });
        yield* Effect.uninterruptible(persist({ ...profile, devices })).pipe(
          Effect.mapError(() => internal()),
        );
        yield* publish;
        return {};
      }),
    );
  const pushHandlers = (deviceId: string) => ({
    "push.register": (registration: PushRegistration) =>
      Effect.gen(function* () {
        const valid = yield* Effect.try({
          try: () =>
            keySchema.safeParse(registration.key).success &&
            decodePushKey(registration.key).length === PUSH_KEY_BYTES,
          catch: () => invalid("The notification key is invalid."),
        });
        if (!valid) return yield* Effect.fail(invalid("The notification key is invalid."));
        return yield* updatePush(deviceId, registration);
      }),
    "push.unregister": () => updatePush(deviceId, undefined),
  });
  const hostIdOf = ({ publicKey }: StoredProfile) =>
    files.keyId(Buffer.from(publicKey, "base64url"));
  const eligible = (deviceId: string) =>
    enabled && state === "listening" && !connected.get(deviceId)?.size;
  const enqueuePush = yield* makePushDelivery({
    recipients: Effect.sync(() => {
      if (!profile) return [];
      const hostId = hostIdOf(profile);
      return profile.devices.flatMap((device) =>
        device.push && eligible(device.id)
          ? [{ deviceId: device.id, hostId, registration: device.push }]
          : [],
      );
    }),
    isCurrent: ({ deviceId, registration }) =>
      Effect.sync(
        () =>
          eligible(deviceId) &&
          profile?.devices.some(
            (device) => device.id === deviceId && device.push === registration,
          ) === true,
      ),
    forget: ({ deviceId, registration }) =>
      mutex.withPermit(
        Effect.gen(function* () {
          if (
            !profile?.devices.some(
              (device) => device.id === deviceId && device.push === registration,
            )
          )
            return;
          const devices = profile.devices.map((device) => {
            if (device.id !== deviceId) return device;
            const { push: _push, ...rest } = device;
            return rest;
          });
          yield* Effect.uninterruptible(persist({ ...profile, devices })).pipe(Effect.ignore);
          yield* publish;
        }),
      ),
  });
  yield* pushEvents.events.pipe(
    Stream.runForEach(enqueuePush),
    Effect.forkScoped({ startImmediately: true }),
  );

  const expire = Effect.gen(function* () {
    if (!offer || offer.expiresAt > now()) return;
    clearOffer();
    yield* publish;
  });

  const handle = (socket: MobileSocket) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (pending >= UNAUTHENTICATED_LIMIT || total >= CHANNEL_LIMIT + UNAUTHENTICATED_LIMIT) {
          socket.close(CHANNEL_CLOSE.overloaded);
          return;
        }
        pending++;
        total++;
        let authenticated = false;
        let admittedId: string | null = null;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            total--;
            if (!authenticated) pending--;
            if (admittedId) {
              const channels = connected.get(admittedId);
              channels?.delete(socket.close);
              if (channels?.size === 0) connected.delete(admittedId);
              yield* publish;
            }
            socket.close(1000);
          }),
        );

        const exchange = Effect.gen(function* () {
          const first = yield* socket.take;
          const exchange = yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* expire;
              if (!profile || state !== "listening") return null;
              const pairing = offer;
              const handshake = yield* Effect.try({
                try: () =>
                  respondToHandshake({
                    message: first,
                    host: {
                      publicKey: Buffer.from(profile!.publicKey, "base64url"),
                      secretKey: Buffer.from(profile!.secretKey, "base64url"),
                    },
                    pairingPsk: pairing?.secret ?? null,
                    randomBytes: files.randomBytes,
                  }),
                catch: () => null,
              }).pipe(Effect.result);
              if (handshake._tag === "Failure") {
                socket.close(
                  first[0] === CHANNEL_HANDSHAKE_PAIR ? CHANNEL_CLOSE.pairingRejected : 1008,
                );
                return null;
              }
              const remote = handshake.success;
              const key = encodeKey(remote.remoteStaticKey);
              const deviceId = files.keyId(remote.remoteStaticKey);
              if (!remote.pairing && !profile.devices.some((device) => device.key === key)) {
                socket.close(CHANNEL_CLOSE.unknownDevice);
                return null;
              }
              const reply = remote.accept(new Uint8Array());
              const hello = {
                protocol: MOBILE_PROTOCOL_REVISION,
                host: {
                  id: hostIdOf(profile),
                  name: hostName,
                  platform: config.platform,
                  appVersion: config.appVersion,
                },
                deviceId,
                routes: [...routes()],
              };
              return {
                ...reply,
                pairing: remote.pairing ? pairing : null,
                payload: remote.payload,
                key,
                deviceId,
                hello,
              };
            }),
          );
          if (!exchange) return null;
          const { channel, reply, deviceId, key, pairing, payload, hello } = exchange;
          yield* socket.send(reply);
          const send = (envelope: MobileEnvelope) =>
            Effect.gen(function* () {
              const bytes = Buffer.from(JSON.stringify(envelope));
              if (bytes.length > CHANNEL_MAX_MESSAGE_BYTES) return false;
              for (const frame of channel.seal(bytes)) yield* socket.send(frame);
              return true;
            });
          const read = Effect.gen(function* () {
            for (;;) {
              const frame = yield* socket.take;
              const decoded = channel.open(frame);
              if (decoded !== null) return MobileEnvelopeSchema.parse(parseJson(decoded));
            }
          });

          // The first handshake message can be replayed from another socket.
          const proof = yield* read;
          if (proof.t !== "ping") {
            socket.close(1008);
            return null;
          }
          const metadata = yield* Effect.try({
            try: () => phonePayload.parse(parseJson(payload)),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));
          if (!metadata) {
            socket.close(1008);
            return null;
          }
          const authorize = yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* expire;
              if (!profile || state !== "listening") return false;
              const existing = profile.devices.find((device) => device.key === key);
              if (pairing && offer !== pairing) {
                socket.close(CHANNEL_CLOSE.pairingRejected);
                return false;
              }
              if (!pairing && !existing) {
                socket.close(CHANNEL_CLOSE.revoked);
                return false;
              }
              if (metadata.protocol !== MOBILE_PROTOCOL_REVISION) {
                yield* send({ t: "hello", d: hello });
                socket.close(CHANNEL_CLOSE.protocolMismatch);
                return false;
              }
              if (pairing && !existing && profile.devices.length >= DEVICE_LIMIT) {
                socket.close(CHANNEL_CLOSE.pairingRejected);
                return false;
              }
              const channels = connected.get(deviceId) ?? new Set<Close>();
              const channelCount = [...connected.values()].reduce(
                (count, value) => count + value.size,
                0,
              );
              if (channelCount >= CHANNEL_LIMIT && channels.size < DEVICE_CHANNEL_LIMIT) {
                socket.close(CHANNEL_CLOSE.overloaded);
                return false;
              }
              if (pairing) {
                const device: StoredDevice = {
                  id: deviceId,
                  key,
                  name: sanitize(metadata.deviceName, 80) || "Phone",
                  platform: sanitize(metadata.platform, 32),
                  appVersion: sanitize(metadata.appVersion, 32),
                  pairedAt: existing?.pairedAt ?? now(),
                  lastSeenAt: now(),
                  ...(existing?.push ? { push: existing.push } : {}),
                };
                // Let a durable write and its in-memory publication settle together before releasing the gate.
                yield* Effect.uninterruptible(
                  persist({
                    ...profile,
                    devices: [...profile.devices.filter((device) => device.key !== key), device],
                  }).pipe(Effect.tap(() => Effect.sync(clearOffer))),
                );
              }
              while (channels.size >= DEVICE_CHANNEL_LIMIT) {
                const oldest = channels.values().next().value!;
                channels.delete(oldest);
                oldest(CHANNEL_CLOSE.overloaded);
              }
              channels.add(socket.close);
              connected.set(deviceId, channels);
              recent.set(deviceId, now());
              admittedId = deviceId;
              authenticated = true;
              pending--;
              yield* publish;
              yield* send({ t: "hello", d: hello });
              yield* send({ t: "pong" });
              return true;
            }),
          );
          if (!authorize) return null;
          return { read, send, deviceId };
        });

        yield* Effect.raceFirst(
          socket.closed,
          Effect.gen(function* () {
            const established = yield* exchange.pipe(Effect.timeout(HANDSHAKE_TIMEOUT));
            if (!established) return;
            const { read, send, deviceId } = established;
            const outgoing = yield* Queue.dropping<MobileEnvelope>(EVENT_CAPACITY);
            const enqueue = yield* Semaphore.make(1);
            const writer = yield* Semaphore.make(1);
            let overflow = false;
            const wake = yield* Queue.sliding<void>(1);
            const push: PushMobileEvent = (k, d) =>
              enqueue.withPermits(1)(
                Effect.gen(function* () {
                  if (overflow) return;
                  if (!(yield* Queue.offer(outgoing, { t: "evt", k, d }))) {
                    overflow = true;
                    yield* Queue.clear(outgoing);
                  }
                  yield* Queue.offer(wake, undefined);
                }),
              );
            // Recovery writes directly on the ordered sender, without competing for queue space.
            const recoveryPush: PushMobileEvent = (k, d) =>
              writer
                .withPermits(1)(send({ t: "evt", k, d }))
                .pipe(Effect.asVoid, Effect.ignore);
            const channelRpc = yield* rpc.open(push);
            const emit = Effect.gen(function* () {
              yield* Queue.take(wake);
              if (overflow) {
                overflow = false;
                yield* channelRpc.recover(
                  recoveryPush,
                  enqueue.withPermits(1)(Queue.clear(outgoing)).pipe(Effect.asVoid),
                );
              }
              yield* writer.withPermit(
                Effect.gen(function* () {
                  const envelope = yield* Queue.poll(outgoing);
                  if (Option.isNone(envelope)) return;
                  yield* send(envelope.value);
                  yield* Queue.offer(wake, undefined);
                }),
              );
            });
            const requests = yield* Semaphore.make(REQUEST_CONCURRENCY);
            const chatLifecycle = yield* Semaphore.make(1);
            let inFlight = 0;
            let lastMessageAt = now();
            const message = (envelope: MobileEnvelope) =>
              Effect.gen(function* () {
                lastMessageAt = now();
                recent.set(deviceId, lastMessageAt);
                if (envelope.t === "ping") {
                  yield* writer.withPermits(1)(send({ t: "pong" }));
                  return;
                }
                if (envelope.t !== "req") {
                  socket.close(1008);
                  return;
                }
                const { id, m, p } = envelope;
                if (inFlight >= REQUEST_LIMIT) {
                  yield* writer.withPermits(1)(
                    send({ t: "res", id, ok: false, e: unavailable("Too many requests at once.") }),
                  );
                  return;
                }
                const invoked = invokeMobileRpc(
                  { ...channelRpc.handlers, ...pushHandlers(deviceId) },
                  m,
                  p,
                ).pipe(
                  Effect.provideService(CoreApplicationAgent, null),
                  Effect.catchDefect(() => Effect.fail(internal())),
                  Effect.timeoutOrElse({
                    duration: ABANDONED_REQUEST_MILLIS,
                    orElse: () => Effect.fail(unavailable("Your desktop is taking too long.")),
                  }),
                );
                const failed = (e: RpcError) => send({ t: "res", id, ok: false, e });
                const succeeded = (r: unknown) =>
                  Effect.gen(function* () {
                    if (!(yield* send({ t: "res", id, ok: true, r })))
                      yield* send({ t: "res", id, ok: false, e: internal() });
                  });
                const answer =
                  m === "chat.open"
                    ? // A chat's snapshot must reach the phone before its first patch, so starting
                      // the watch and answering share the writer. The read before them does not:
                      // a busy desktop can delay this chat, but not pongs or anything else.
                      (invoked as Effect.Effect<Effect.Effect<unknown, RpcError>, RpcError>).pipe(
                        Effect.matchEffect({
                          onFailure: (e) => writer.withPermits(1)(failed(e)),
                          onSuccess: (start) =>
                            writer.withPermits(1)(
                              start.pipe(
                                Effect.matchEffect({ onFailure: failed, onSuccess: succeeded }),
                              ),
                            ),
                        }),
                      )
                    : invoked.pipe(
                        Effect.matchEffect({
                          onFailure: (e) => writer.withPermits(1)(failed(e)),
                          onSuccess: (r) => writer.withPermits(1)(succeeded(r)),
                        }),
                      );
                inFlight++;
                yield* (CHAT_LIFECYCLE_METHODS.has(m) ? chatLifecycle : requests)
                  .withPermits(1)(answer)
                  .pipe(
                    Effect.ensuring(Effect.sync(() => inFlight--)),
                    Effect.ignore,
                    Effect.forkScoped({ startImmediately: true }),
                  );
              });
            const idle = Effect.gen(function* () {
              for (;;) {
                const remaining = IDLE_MILLIS - (now() - lastMessageAt);
                if (remaining <= 0) return;
                yield* Effect.sleep(remaining);
              }
            });
            return yield* Effect.raceFirst(
              idle,
              Effect.raceFirst(
                Effect.forever(emit),
                Effect.forever(read.pipe(Effect.flatMap(message))),
              ),
            );
          }),
        ).pipe(Effect.ignoreCause);
      }),
    );

  const start = Effect.gen(function* () {
    state = "starting";
    failureMessage = null;
    yield* publish;
    const child = yield* Scope.fork(scope);
    const startListening = Effect.gen(function* () {
      if (!secrets.isAvailable())
        return yield* failure("Unlock this device’s secure storage to enable Mobile Access.");
      const saved = (yield* readProfile) ?? freshProfile(generateStaticKeyPair(files.randomBytes));
      const bind = (port: number) =>
        listenMobileSocket(port, isPrivateMobilePeer).pipe(Scope.provide(child));
      const bound = yield* bind(saved.port).pipe(
        Effect.catchIf(
          (error) => error.reason === "address-in-use",
          () => bind(0),
        ),
        Effect.mapError(() => failure("Mobile Access could not listen on this network.")),
      );
      if (profile === null || saved.port !== bound.port) {
        yield* Effect.uninterruptible(persist({ ...saved, port: bound.port }));
      } else {
        profile = saved;
      }
      listener = child;
      state = "listening";
      yield* Effect.forever(
        Effect.gen(function* () {
          const socket = yield* bound.accept;
          yield* Effect.forkIn(handle(socket), child, { startImmediately: true });
        }),
      ).pipe(Effect.forkIn(child));
      yield* publish;
    });
    yield* startListening.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Scope.close(child, Exit.void);
          setFailure(error.message);
          yield* publish;
        }),
      ),
    );
  });

  const flushLastSeen = Effect.gen(function* () {
    if (!profile) return;
    let changed = false;
    const devices = profile.devices.map((device) => {
      const seen = recent.get(device.id);
      if (seen === undefined || seen === device.lastSeenAt) return device;
      changed = true;
      return { ...device, lastSeenAt: seen };
    });
    if (changed) yield* Effect.uninterruptible(persist({ ...profile, devices }));
  });
  const initial = yield* settings.snapshot().pipe(Effect.orElseSucceed(() => null));
  enabled = initial?.mobileAccessEnabled === true;
  if (enabled) yield* mutex.withPermits(1)(start).pipe(Effect.forkScoped);
  else profile = yield* readProfile.pipe(Effect.orElseSucceed(() => null));
  // Quiet while nobody can connect, so a feature that is off costs no wakeups.
  yield* Effect.forever(
    Effect.suspend(() => Effect.sleep(state === "listening" ? "1 second" : "1 minute")).pipe(
      Effect.andThen(
        mutex.withPermits(1)(
          Effect.gen(function* () {
            yield* expire;
            if (state === "listening" && now() >= nextLastSeenWrite) {
              nextLastSeenWrite = now() + LAST_SEEN_INTERVAL;
              yield* flushLastSeen.pipe(Effect.ignore);
              yield* publish;
            }
          }),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);

  return MobileGateway.of({
    status,
    changes: SubscriptionRef.changes(tick).pipe(Stream.as(undefined)),
    setEnabled: (next) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          if (enabled !== next) {
            const saved = yield* settings
              .update({ type: "update-mobile-access", enabled: next })
              .pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
            if (!saved) {
              failureMessage = "Mobile Access could not save the Profile setting.";
              yield* publish;
              return yield* status;
            }
            enabled = next;
          }
          if (next && !listener) yield* start.pipe(Effect.uninterruptible);
          if (!next) {
            clearOffer();
            failureMessage = null;
            state = "off";
            if (listener) yield* Scope.close(listener, Exit.void);
            listener = null;
            yield* flushLastSeen.pipe(Effect.ignore);
            yield* publish;
          }
          return yield* status;
        }).pipe(Effect.uninterruptible),
      ),
    beginPairing: mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* expire;
        if (offer || state !== "listening") return yield* status;
        if (routes().length === 0) {
          failureMessage = "Connect this device to a private network to pair a phone.";
        } else {
          failureMessage = null;
          offer = {
            secret: files.randomBytes(32),
            expiresAt: now() + PAIRING_LIFETIME,
          };
        }
        yield* publish;
        return yield* status;
      }),
    ),
    cancelPairing: mutex.withPermits(1)(
      Effect.sync(clearOffer).pipe(Effect.andThen(publish), Effect.andThen(status)),
    ),
    revoke: (deviceId) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          if (!profile) return yield* status;
          const devices = profile.devices.filter((device) => device.id !== deviceId);
          if (devices.length === profile.devices.length) return yield* status;
          yield* Effect.uninterruptible(
            persist({ ...profile, devices }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  for (const close of connected.get(deviceId) ?? []) close(CHANNEL_CLOSE.revoked);
                  connected.delete(deviceId);
                  recent.delete(deviceId);
                }),
              ),
              Effect.catch((error) =>
                Effect.sync(() => {
                  failureMessage = error.message;
                }),
              ),
            ),
          );
          yield* publish;
          return yield* status;
        }),
      ),
  });
});

export const live = Layer.effect(MobileGateway, make);
