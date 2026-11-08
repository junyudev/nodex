import { createHash } from "node:crypto";
import {
  CHANNEL_CLOSE,
  CHANNEL_HANDSHAKE_PAIR,
  generateStaticKeyPair,
  MOBILE_PROTOCOL_REVISION,
  MobileEnvelopeSchema,
  respondToHandshake,
  type MobileEnvelope,
  type RpcError,
  type SecureChannel,
} from "@nodex/mobile-protocol";
import { z } from "zod";
import type {
  LocalImage,
  MobilePlatform,
  MobilePush,
  MobileSocket,
  MobileSocketEvents,
} from "./platform";

const deliver = (callback: () => void) => {
  void Promise.resolve().then(callback);
};

type Request = Extract<MobileEnvelope, { t: "req" }>;
type ServerSocket = Pick<MobileSocketEvents, "frame" | "closed">;

function seedRandom(prefix = "phone") {
  let seed = 0;
  return (length: number) =>
    length === 1
      ? Uint8Array.of(128)
      : createHash("sha256").update(`${prefix}:${++seed}`).digest().subarray(0, length);
}

const PhonePayload = z.looseObject({
  protocol: z.number().int(),
  deviceName: z.string().min(1).max(256),
  platform: z.enum(["ios", "android"]),
  appVersion: z.string().min(1).max(128),
});

export class FakeHost {
  private readonly randomBytes: (length: number) => Uint8Array;
  readonly key: ReturnType<typeof generateStaticKeyPair>;
  readonly pairingKeys: string[] = [];
  readonly metadata: z.output<typeof PhonePayload>[] = [];
  readonly psk = new Uint8Array(32).fill(42);
  readonly requests: Request[] = [];
  readonly firstEnvelopes: MobileEnvelope[] = [];
  readonly trace: string[] = [];
  private readonly devices = new Map<string, string>();
  readonly peers = new Set<{
    emit: (envelope: MobileEnvelope) => void;
    close: (code: number) => void;
  }>();
  protocol = MOBILE_PROTOCOL_REVISION;
  pairingAvailable = true;
  handshakeReplyDelay = 0;
  onPaired?: () => void;
  allowHello = true;
  pong = true;
  routes: string[];
  onRequest: (
    request: Request,
    reply: (result: unknown) => void,
    fail: (message: string, retryable: boolean, code?: RpcError["code"]) => void,
  ) => void = (request, reply) => {
    if (request.m === "projects.list") reply({ projects: [], libraryInboxCount: 0 });
    else if (request.m === "agents.catalog") reply({ providers: [], defaultChoice: null });
    else if (request.m === "inbox.window" || request.m === "chats.list")
      reply({ items: [], nextCursor: null });
    else if (request.m === "chats.unread")
      reply({ sessionIds: (request.p as { sessionIds: string[] }).sessionIds });
    else reply({});
  };

  constructor(
    readonly id = "host-a",
    routes = ["ws://host-a:3000/mobile"],
  ) {
    this.routes = routes;
    this.randomBytes = seedRandom(id);
    this.key = generateStaticKeyPair(this.randomBytes);
  }

  attach(socket: ServerSocket) {
    let payload: Uint8Array | undefined;
    let channel: SecureChannel | null = null;
    let authorized = false;
    let identity = "";
    let pairing = false;
    let disconnected = false;
    let deviceId = "";

    function toPhone(frame: Uint8Array) {
      deliver(() => {
        if (!disconnected) socket.frame(frame);
      });
    }

    const peer = {
      emit(envelope: MobileEnvelope) {
        if (!channel || disconnected) return;
        const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
        for (const frame of channel.seal(plaintext)) toPhone(frame);
      },
      close: (code: number) => {
        if (disconnected) return;
        disconnected = true;
        this.peers.delete(peer);
        deliver(() => socket.closed(code));
      },
    };
    this.peers.add(peer);

    const hello = (withPong: boolean) => {
      peer.emit({
        t: "hello",
        d: {
          host: { id: this.id, name: this.id, platform: "macOS", appVersion: "1" },
          protocol: this.protocol,
          deviceId,
          routes: this.routes,
        },
      });
      if (withPong) peer.emit({ t: "pong" });
    };

    return {
      close: () => peer.close(1000),
      send: (frame: Uint8Array) =>
        deliver(() => {
          if (disconnected) return;
          if (!channel) {
            try {
              const handshake = respondToHandshake({
                message: frame,
                host: this.key,
                pairingPsk: this.pairingAvailable ? this.psk : null,
                randomBytes: this.randomBytes,
              });
              identity = Buffer.from(handshake.remoteStaticKey).toString("hex");
              pairing = handshake.pairing;
              payload = handshake.payload;
              if (pairing) this.pairingKeys.push(identity);
              if (!pairing && !this.devices.has(identity))
                return peer.close(CHANNEL_CLOSE.unknownDevice);
              const accepted = handshake.accept(new Uint8Array());
              channel = accepted.channel;
              this.trace.push("handshake.reply");
              if (this.handshakeReplyDelay > 0) {
                setTimeout(() => toPhone(accepted.reply), this.handshakeReplyDelay);
              } else toPhone(accepted.reply);
            } catch {
              peer.close(
                frame[0] === CHANNEL_HANDSHAKE_PAIR ? CHANNEL_CLOSE.pairingRejected : 1006,
              );
            }
            return;
          }
          const message = channel.open(frame);
          if (!message) return;
          const envelope = MobileEnvelopeSchema.parse(
            JSON.parse(new TextDecoder().decode(message)),
          );
          if (!authorized) {
            this.firstEnvelopes.push(envelope);
            this.trace.push(envelope.t);
            if (envelope.t !== "ping") return peer.close(CHANNEL_CLOSE.protocolMismatch);
            let metadata: z.output<typeof PhonePayload>;
            try {
              metadata = PhonePayload.parse(JSON.parse(new TextDecoder().decode(payload)));
            } catch {
              return peer.close(1008);
            }
            this.metadata.push(metadata);
            if (metadata.protocol !== this.protocol) {
              deviceId = this.devices.get(identity) ?? `device-${this.devices.size + 1}`;
              hello(false);
              return;
            }
            if (pairing) {
              if (!this.pairingAvailable) return peer.close(CHANNEL_CLOSE.pairingRejected);
              this.pairingAvailable = false;
              this.devices.set(identity, `device-${this.devices.size + 1}`);
              this.onPaired?.();
            }
            deviceId = this.devices.get(identity) ?? "";
            authorized = true;
            if (this.allowHello) {
              this.trace.push("hello", "pong");
              hello(true);
            }
            return;
          }
          if (envelope.t === "ping" && this.pong) peer.emit({ t: "pong" });
          if (envelope.t !== "req") return;
          this.requests.push(envelope);
          this.onRequest(
            envelope,
            (r) => peer.emit({ t: "res", id: envelope.id, ok: true, r }),
            (message, retryable, code = retryable ? "unavailable" : "rejected") =>
              peer.emit({
                t: "res",
                id: envelope.id,
                ok: false,
                e: { code, message, retryable },
              }),
          );
        }),
    };
  }

  closeAll(code = 1006) {
    for (const peer of this.peers) peer.close(code);
  }

  emit(envelope: MobileEnvelope) {
    for (const peer of this.peers) peer.emit(envelope);
  }

  pairingOffer(expiresAt: number, routes = this.routes) {
    return {
      hostKey: Buffer.from(this.key.publicKey).toString("base64url"),
      hostName: this.id,
      secret: Buffer.from(this.psk).toString("base64url"),
      expiresAt,
      routes,
    };
  }
}

export function fakePlatform() {
  const data = new Map<string, string>();
  const secrets = new Map<string, string>();
  const files = new Map<string, Uint8Array>();
  const routes = new Map<string, FakeHost | "stall" | "unreachable" | number>();
  const dials: { route: string; at: number; closed: boolean }[] = [];
  const listeners = new Set<(foreground: boolean) => void>();
  const compression: { image: LocalImage; longestSide: number; quality: number }[] = [];
  let foreground = true;
  const keyValue = (map: Map<string, string>) => ({
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => {
      map.set(key, value);
    },
    remove: (key: string) => {
      map.delete(key);
    },
  });
  const platform = {
    push: null as MobilePush | null,
    deviceName: "Test phone",
    platform: "ios",
    appVersion: "1.0.0",
    data,
    savedSecrets: secrets,
    contents: files,
    routes,
    dials,
    compression,
    storage: keyValue(data),
    secrets: keyValue(secrets),
    files: {
      uri: (area, name) => `file://${area}/${name}`,
      copy(source, destination) {
        const bytes = files.get(source);
        if (!bytes) throw new Error("Missing file");
        files.set(destination, bytes.slice());
      },
      remove(uri) {
        files.delete(uri);
      },
      size: (uri) => files.get(uri)?.length ?? null,
      async read(uri, offset, length) {
        const bytes = files.get(uri);
        if (!bytes) throw new Error("Missing file");
        return bytes.slice(offset, offset + length);
      },
      async append(uri, bytes) {
        const existing = files.get(uri) ?? new Uint8Array();
        const merged = new Uint8Array(existing.length + bytes.length);
        merged.set(existing);
        merged.set(bytes, existing.length);
        files.set(uri, merged);
      },
    },
    async compressImage(image, longestSide, quality) {
      compression.push({ image, longestSide, quality });
      const uri = `file://cache/compressed-${compression.length}.jpg`;
      platform.files.copy(image.uri, uri);
      return { ...image, uri, width: Math.min(image.width, longestSide), mimeType: "image/jpeg" };
    },
    randomBytes: seedRandom(),
    now: () => Date.now(),
    schedule(callback, ms) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    socket(route) {
      const target = routes.get(route);
      const dial = { route, at: Date.now(), closed: false };
      dials.push(dial);
      let peer: ReturnType<FakeHost["attach"]> | undefined;
      let listeners: MobileSocketEvents | null = null;
      const socket: MobileSocket = {
        listen(events) {
          listeners = events;
          return () => {
            listeners = null;
          };
        },
        send(bytes) {
          if (dial.closed || !peer) throw new Error("Socket closed");
          peer.send(bytes);
        },
        close() {
          dial.closed = true;
          peer?.close();
        },
      };
      deliver(() => {
        if (dial.closed || target === "stall") return;
        if (typeof target === "number") return listeners?.closed(target);
        if (!target || target === "unreachable") return listeners?.failed();
        peer = target.attach({
          frame: (bytes) => listeners?.frame(bytes),
          closed: (code) => listeners?.closed(code),
        });
        listeners?.open();
      });
      return socket;
    },
    isForeground: () => foreground,
    onForegroundChange(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    setForeground(value: boolean) {
      foreground = value;
      for (const listener of listeners) listener(value);
    },
  } satisfies MobilePlatform & {
    data: Map<string, string>;
    savedSecrets: Map<string, string>;
    contents: Map<string, Uint8Array>;
    routes: typeof routes;
    dials: typeof dials;
    compression: typeof compression;
    setForeground(value: boolean): void;
  };
  return platform;
}
