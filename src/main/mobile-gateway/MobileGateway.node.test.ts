import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  CHANNEL_CLOSE,
  CHANNEL_HANDSHAKE_CONNECT,
  CHANNEL_HANDSHAKE_PAIR,
  MOBILE_PROTOCOL_REVISION,
  MobileEnvelopeSchema,
  beginHandshake,
  generateStaticKeyPair,
  parsePairingUri,
  type MobileEnvelope,
  type SecureChannel,
  type StaticKeyPair,
} from "@nodex/mobile-protocol";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import WebSocket from "ws";
import { expect } from "vitest";
import { testLayer as configLayer } from "../app/MainConfig";
import { SecretEncryption } from "../platform/SecretEncryption";
import { live as profileFiles } from "../platform/node/MobileProfileFiles";
import { listenMobileSocket } from "../platform/node/MobileSocket";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
import { live as gatewayLayer, MobileGateway } from "./MobileGateway";
import { MobileRpc, type MobileHandlers, type PushMobileEvent } from "./rpc";

const envelopeSchema = MobileEnvelopeSchema;

const sample = {
  sessionId: "test-chat",
  revision: 129,
  title: "Chat",
  projectName: null,
  items: [],
  historyCursor: null,
  state: {
    status: "idle" as const,
    activeRunId: null,
    queuedCount: 0,
    requests: [],
    agentLabel: null,
    sendBlockedReason: null,
  },
};

const openSocket = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const ws = new WebSocket(url);
      const frames: Buffer[] = [];
      let ready: (() => void) | undefined;
      ws.on("message", (frame) => {
        frames.push(Buffer.from(frame as Buffer));
        ready?.();
        ready = undefined;
      });
      const close = once(ws, "close").then(([code]) => code as number);
      await once(ws, "open");
      const next = async (): Promise<Buffer> => {
        if (!frames.length)
          await Promise.race([
            new Promise<void>((resolve) => {
              ready = resolve;
            }),
            close.then((code) => {
              throw new Error(`Socket closed while awaiting a frame (${code})`);
            }),
          ]);
        return frames.shift()!;
      };
      return {
        ws,
        frames,
        next,
        close,
        read: async (channel: SecureChannel): Promise<MobileEnvelope> => {
          for (;;) {
            const message = channel.open(await next());
            if (message) return envelopeSchema.parse(JSON.parse(Buffer.from(message).toString()));
          }
        },
        send: (channel: SecureChannel, envelope: MobileEnvelope) => {
          for (const frame of channel.seal(Buffer.from(JSON.stringify(envelope)))) ws.send(frame);
        },
      };
    }),
    ({ ws }) => Effect.sync(() => ws.terminate()),
  );

const handshake = (
  hostKey: string,
  device: StaticKeyPair,
  secret?: Buffer,
  protocol = MOBILE_PROTOCOL_REVISION,
) =>
  beginHandshake({
    hostPublicKey: Buffer.from(hostKey, "base64url"),
    device,
    psk: secret,
    randomBytes,
    payload: Buffer.from(
      JSON.stringify({ protocol, deviceName: "Test\nPhone", platform: "test", appVersion: "1" }),
    ),
  });

const fixture = Effect.gen(function* () {
  const home = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-mobile-socket-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  let enabled = false;
  let requests = 0;
  let secretAvailable = true;
  let chatOpenRead: Effect.Effect<void> = Effect.void;
  const settings = makeTestApplicationSettings();
  const snapshot = () =>
    settings.snapshot().pipe(Effect.map((value) => ({ ...value, mobileAccessEnabled: enabled })));
  const dependencies = Layer.mergeAll(
    configLayer({ nodexHome: home, isPackaged: false }),
    profileFiles,
    Layer.succeed(ApplicationSettings, {
      ...settings,
      snapshot,
      update: (command) =>
        Effect.sync(() => {
          if (command.type === "update-mobile-access") enabled = command.enabled;
        }).pipe(Effect.andThen(snapshot())),
    }),
    Layer.succeed(SecretEncryption, {
      isAvailable: () => secretAvailable,
      encryptString: (plaintext) => Buffer.from(Buffer.from(plaintext).map((byte) => byte ^ 0xa9)),
      decryptString: (encrypted) =>
        Buffer.from(encrypted)
          .map((byte) => byte ^ 0xa9)
          .toString(),
    }),
    Layer.succeed(MobileRpc, {
      open: (push: PushMobileEvent) =>
        Effect.succeed({
          handlers: {
            "projects.list": () =>
              Effect.gen(function* () {
                requests++;
                if (requests === 1) yield* push("changed", { topics: ["projects"] });
                return { projects: [], libraryInboxCount: 0 };
              }),
            "chat.open": () =>
              chatOpenRead.pipe(
                Effect.as(
                  Effect.gen(function* () {
                    requests++;
                    for (let revision = 1; revision <= sample.revision; revision++) {
                      yield* push("chat.patch", {
                        sessionId: sample.sessionId,
                        revision,
                        ops: [{ op: "title", title: String(revision) }],
                      });
                    }
                    return sample;
                  }),
                ),
              ),
            "chat.close": () => Effect.succeed({}),
          } as unknown as MobileHandlers,
          recover: (push, discard) => discard.pipe(Effect.andThen(push("chat.snapshot", sample))),
        }),
    }),
  );
  return {
    home,
    requests: () => requests,
    holdChatOpenRead: (read: Effect.Effect<void>) => {
      chatOpenRead = read;
    },
    encryption: (available: boolean) => {
      secretAvailable = available;
    },
    layer: gatewayLayer.pipe(Layer.provide(dependencies)),
  };
});

it.effect(
  "pairs over a real Noise WebSocket, rejects replays, restores delivery and revokes immediately",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* Effect.gen(function* () {
        const gateway = yield* MobileGateway;
        expect(yield* gateway.status).toMatchObject({ enabled: false, state: "off" });
        test.encryption(false);
        expect(yield* gateway.setEnabled(true)).toMatchObject({
          state: "failed",
          failureMessage: expect.stringContaining("secure storage"),
        });
        test.encryption(true);
        expect(yield* gateway.setEnabled(true)).toMatchObject({ state: "listening" });
        const expired = parsePairingUri((yield* gateway.beginPairing).pairing!.uri)!;
        const route = expired.routes.find((route) => route.includes("127.0.0.1"))!;
        const http = yield* Effect.promise(() => fetch(route.replace("ws:", "http:")));
        expect(http.status).toBe(404);
        expect(yield* Effect.promise(() => http.text())).toBe("");
        const device = generateStaticKeyPair(randomBytes);
        const expiredSecret = Buffer.from(expired.secret, "base64url");
        yield* TestClock.adjust("5 minutes");
        expect((yield* gateway.status).pairing).toBeNull();
        const reject = (wire: Uint8Array, code: number) =>
          Effect.scoped(
            Effect.gen(function* () {
              const socket = yield* openSocket(route);
              socket.ws.send(wire);
              expect(yield* Effect.promise(() => socket.close)).toBe(code);
            }),
          );
        yield* reject(
          handshake(expired.hostKey, device, expiredSecret).message,
          CHANNEL_CLOSE.pairingRejected,
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* openSocket(route);
            let pongs = 0;
            socket.ws.on("pong", () => pongs++);
            for (let n = 0; n < 32; n++) socket.ws.ping("unauthenticated");
            socket.ws.send(Uint8Array.of(CHANNEL_HANDSHAKE_CONNECT));
            expect(yield* Effect.promise(() => socket.close)).toBe(1008);
            expect(pongs).toBe(0);
          }),
        );
        const offer = parsePairingUri((yield* gateway.beginPairing).pairing!.uri)!;
        expect(offer.secret).not.toBe(expired.secret);
        const invalidPairing = Buffer.alloc(1 + 96);
        invalidPairing[0] = CHANNEL_HANDSHAKE_PAIR;
        for (let n = 0; n < 12; n++) {
          yield* reject(invalidPairing, CHANNEL_CLOSE.pairingRejected);
        }
        yield* reject(
          handshake(offer.hostKey, device, randomBytes(32)).message,
          CHANNEL_CLOSE.pairingRejected,
        );
        expect(parsePairingUri((yield* gateway.status).pairing!.uri)).toEqual(offer);

        const pairing = handshake(offer.hostKey, device, Buffer.from(offer.secret, "base64url"));
        const phone = yield* openSocket(route);
        phone.ws.send(pairing.message);
        const channel = pairing.finish(yield* Effect.promise(phone.next)).channel;
        const ping = { t: "ping" } as const;
        const pairReplay = yield* openSocket(route);
        pairReplay.ws.send(pairing.message);
        yield* Effect.promise(pairReplay.next);
        expect((yield* gateway.status).devices).toEqual([]);
        expect((yield* gateway.status).pairing).not.toBeNull();
        // A ping sealed for the original channel cannot authenticate the replay socket.
        const sealedPing = channel.seal(Buffer.from(JSON.stringify(ping)))[0]!;
        pairReplay.ws.send(sealedPing);
        yield* Effect.promise(() => pairReplay.close);
        expect(pairReplay.frames).toEqual([]);
        expect((yield* gateway.status).devices).toEqual([]);
        expect((yield* gateway.status).pairing).not.toBeNull();
        expect(test.requests()).toBe(0);

        phone.ws.send(sealedPing);
        const hello = yield* Effect.promise(() => phone.read(channel));
        expect(hello).toMatchObject({ t: "hello", d: { protocol: MOBILE_PROTOCOL_REVISION } });
        expect(yield* Effect.promise(() => phone.read(channel))).toEqual({ t: "pong" });
        const deviceId = hello.t === "hello" ? hello.d.deviceId : "";
        expect(yield* gateway.status).toMatchObject({
          pairing: null,
          devices: [{ id: deviceId, name: "TestPhone", connected: true }],
        });
        const stored = yield* Effect.promise(() =>
          readFile(join(test.home, "mobile-access.json"), "utf8"),
        );
        expect(Object.keys(JSON.parse(stored))).toEqual(["encrypted"]);
        expect(stored).not.toContain(offer.hostKey);
        yield* reject(pairing.message, CHANNEL_CLOSE.pairingRejected);
        yield* reject(
          handshake(offer.hostKey, generateStaticKeyPair(randomBytes)).message,
          CHANNEL_CLOSE.unknownDevice,
        );

        phone.send(channel, { t: "req", id: 1, m: "projects.list", p: {} });
        const messages = [
          yield* Effect.promise(() => phone.read(channel)),
          yield* Effect.promise(() => phone.read(channel)),
        ];
        expect(messages).toEqual(
          expect.arrayContaining([
            { t: "res", id: 1, ok: true, r: { projects: [], libraryInboxCount: 0 } },
            { t: "evt", k: "changed", d: { topics: ["projects"] } },
          ]),
        );
        phone.send(channel, {
          t: "req",
          id: 2,
          m: "chat.open",
          p: { sessionId: sample.sessionId },
        });
        expect(yield* Effect.promise(() => phone.read(channel))).toMatchObject({
          t: "res",
          id: 2,
          ok: true,
        });
        expect(yield* Effect.promise(() => phone.read(channel))).toEqual({
          t: "evt",
          k: "chat.snapshot",
          d: sample,
        });

        phone.ws.close();
        yield* Effect.promise(() => phone.close);
        const previousSeen = (yield* gateway.status).devices[0]!.lastSeenAt;
        yield* TestClock.adjust("1 second");
        const mismatch = handshake(offer.hostKey, device, undefined, MOBILE_PROTOCOL_REVISION + 1);
        const older = yield* openSocket(route);
        older.ws.send(mismatch.message);
        const mismatchedChannel = mismatch.finish(yield* Effect.promise(older.next)).channel;
        older.send(mismatchedChannel, ping);
        expect(yield* Effect.promise(() => older.read(mismatchedChannel))).toMatchObject({
          t: "hello",
        });
        expect(yield* Effect.promise(() => older.close)).toBe(CHANNEL_CLOSE.protocolMismatch);
        expect((yield* gateway.status).devices[0]?.lastSeenAt).toBe(previousSeen);
        const reconnect = handshake(offer.hostKey, device);
        const real = yield* openSocket(route);
        real.ws.send(reconnect.message);
        const channel2 = reconnect.finish(yield* Effect.promise(real.next)).channel;
        const connectReplay = yield* openSocket(route);
        connectReplay.ws.send(reconnect.message);
        yield* Effect.promise(connectReplay.next);
        const proof = channel2.seal(Buffer.from(JSON.stringify(ping)))[0]!;
        connectReplay.ws.send(proof);
        yield* Effect.promise(() => connectReplay.close);
        expect(connectReplay.frames).toEqual([]);
        expect(yield* gateway.status).toMatchObject({
          devices: [{ connected: false, lastSeenAt: previousSeen }],
        });
        expect(test.requests()).toBe(2);

        real.ws.send(proof);
        expect(yield* Effect.promise(() => real.read(channel2))).toMatchObject({
          t: "hello",
          d: { deviceId },
        });
        expect(yield* Effect.promise(() => real.read(channel2))).toEqual({ t: "pong" });
        const revoked = yield* openSocket(route);
        const pendingMismatch = handshake(
          offer.hostKey,
          device,
          undefined,
          MOBILE_PROTOCOL_REVISION + 1,
        );
        revoked.ws.send(pendingMismatch.message);
        const revokedChannel = pendingMismatch.finish(yield* Effect.promise(revoked.next)).channel;

        expect((yield* gateway.revoke(deviceId)).devices).toEqual([]);
        expect(yield* Effect.promise(() => real.close)).toBe(CHANNEL_CLOSE.revoked);
        revoked.send(revokedChannel, ping);
        expect(yield* Effect.promise(() => revoked.close)).toBe(CHANNEL_CLOSE.revoked);
        expect(revoked.frames).toEqual([]);
        yield* reject(reconnect.message, CHANNEL_CLOSE.unknownDevice);

        expect((yield* gateway.setEnabled(false)).routes).toEqual([]);
        expect((yield* gateway.setEnabled(true)).routes).toContain(route);
        const cancelledOffer = parsePairingUri((yield* gateway.beginPairing).pairing!.uri)!;
        const pendingPairing = handshake(
          cancelledOffer.hostKey,
          device,
          Buffer.from(cancelledOffer.secret, "base64url"),
          MOBILE_PROTOCOL_REVISION + 1,
        );
        const cancelled = yield* openSocket(route);
        cancelled.ws.send(pendingPairing.message);
        const cancelledChannel = pendingPairing.finish(
          yield* Effect.promise(cancelled.next),
        ).channel;
        yield* gateway.cancelPairing;
        cancelled.send(cancelledChannel, ping);
        expect(yield* Effect.promise(() => cancelled.close)).toBe(CHANNEL_CLOSE.pairingRejected);
        expect(cancelled.frames).toEqual([]);
      }).pipe(Effect.provide(test.layer));
    }),
  20_000,
);

it.effect("a chat slow to open holds up nothing else on the connection", () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    yield* Effect.gen(function* () {
      const gateway = yield* MobileGateway;
      yield* gateway.setEnabled(true);
      const offer = parsePairingUri((yield* gateway.beginPairing).pairing!.uri)!;
      const route = offer.routes.find((candidate) => candidate.includes("127.0.0.1"))!;
      const device = generateStaticKeyPair(randomBytes);
      const pairing = handshake(offer.hostKey, device, Buffer.from(offer.secret, "base64url"));
      const phone = yield* openSocket(route);
      phone.ws.send(pairing.message);
      const channel = pairing.finish(yield* Effect.promise(phone.next)).channel;
      const read = Effect.promise(() => phone.read(channel));
      phone.send(channel, { t: "ping" });
      expect(yield* read).toMatchObject({ t: "hello" });
      expect(yield* read).toEqual({ t: "pong" });

      const open = { sessionId: sample.sessionId };
      test.holdChatOpenRead(Effect.never);
      phone.send(channel, { t: "req", id: 1, m: "chat.open", p: open });
      phone.send(channel, { t: "req", id: 2, m: "chat.close", p: open });
      phone.send(channel, { t: "ping" });
      expect(yield* read).toEqual({ t: "pong" });
      phone.send(channel, { t: "req", id: 3, m: "projects.list", p: {} });
      expect(yield* Effect.all([read, read])).toEqual(
        expect.arrayContaining([expect.objectContaining({ t: "res", id: 3, ok: true })]),
      );

      // Once the phone has stopped waiting, the read gives way to what the phone sent next.
      yield* TestClock.adjust("30 seconds");
      expect(yield* read).toMatchObject({ t: "res", id: 1, ok: false, e: { retryable: true } });
      expect(yield* read).toEqual({ t: "res", id: 2, ok: true, r: {} });

      test.holdChatOpenRead(Effect.void);
      phone.send(channel, { t: "req", id: 4, m: "chat.open", p: open });
      expect(yield* read).toMatchObject({ t: "res", id: 4, ok: true });
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  }),
);

it.effect("terminates a WebSocket whose pending writes exceed the budget", () =>
  Effect.gen(function* () {
    const listener = yield* listenMobileSocket(0, () => true);
    const peer = yield* openSocket(`ws://127.0.0.1:${listener.port}/mobile`);
    const socket = yield* listener.accept;
    const frame = new Uint8Array(65_535);
    peer.ws.pause();
    try {
      const sends = yield* Effect.all(
        Array.from({ length: 256 }, () => socket.send(frame).pipe(Effect.result)),
        { concurrency: "unbounded" },
      );
      expect(sends.some(Result.isFailure)).toBe(true);
      yield* socket.closed;
    } finally {
      peer.ws.resume();
    }
    expect(yield* Effect.promise(() => peer.close)).toBe(1006);
  }),
);
