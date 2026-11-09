import { createHash } from "node:crypto";
import {
  MOBILE_PROTOCOL_REVISION,
  MobileEnvelopeSchema,
  type MobileEnvelope,
  type Hello,
  type RpcError,
  spaceMemberKey,
} from "@nodex/mobile-protocol";
import type { LocalImage, MobilePlatform, MobilePush } from "./platform";
import { makePinnedTls, type NativeTlsOptions, type TlsEvent } from "./pinned-tls";
import { decodeUtf8, encodeUtf8, fromBase64, toBase64 } from "./encoding";

const deliver = (callback: () => void) => {
  void Promise.resolve().then(callback);
};
type Request = Extract<MobileEnvelope, { t: "req" }>;
function seedRandom(prefix = "phone") {
  let seed = 0;
  return (length: number) =>
    length === 1
      ? Uint8Array.of(128)
      : createHash("sha256").update(`${prefix}:${++seed}`).digest().subarray(0, length);
}

/** A pinned Core enrollment/session frontier with an admitted host phone stream. */
export class FakeHost {
  readonly fingerprint: string;
  readonly requests: Request[] = [];
  readonly admissions: { memberId: string; request: Request }[] = [];
  readonly httpRequests: { path: string; body: unknown }[] = [];
  readonly peers = new Set<{ emit(envelope: MobileEnvelope): void; close(code: number): void }>();
  readonly credentials = new Map<string, { deviceId: string; memberId: string }>();
  readonly tokens = new Map<string, { deviceId: string; memberId: string }>();
  memberId = "owner";
  spaceKind: Hello["spaceKind"] = "personal";
  protocol = MOBILE_PROTOCOL_REVISION;
  pairingAvailable = true;
  revoked = false;
  allowHello = true;
  pong = true;
  routes: string[];
  sessionSeconds = 3600;
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
    else if (request.m === "inbox.turns")
      reply({ pageIds: (request.p as { pageIds: string[] }).pageIds });
    else reply({});
  };
  constructor(
    readonly id = "host-a",
    routes = ["https://host-a:3000/"],
  ) {
    this.routes = routes;
    this.fingerprint = createHash("sha256").update(id).digest("hex");
  }
  http(path: string, body: unknown) {
    this.httpRequests.push({ path, body });
    if (path === "/enroll") {
      if (!this.pairingAvailable || (body as { code: string }).code !== "device-link-code")
        return { status: 403, body: { payload: { recovery: { kind: "none" } } } };
      this.pairingAvailable = false;
      const deviceId = `device-${this.credentials.size + 1}`;
      const credential = createHash("sha256").update(`${this.id}:${deviceId}`).digest("hex");
      this.credentials.set(credential, { deviceId, memberId: this.memberId });
      return {
        status: 200,
        body: {
          space_id: this.id,
          space_name: this.id,
          member_id: this.memberId,
          device_id: deviceId,
          device_credential: credential,
        },
      };
    }
    const identity = this.credentials.get(
      (body as { device_credential: string }).device_credential,
    );
    if (!identity || this.revoked)
      return { status: 403, body: { payload: { recovery: { kind: "remote_access_withdrawn" } } } };
    const token = createHash("sha256").update(`${this.id}:${this.tokens.size}`).digest("hex");
    this.tokens.set(token, identity);
    return {
      status: 200,
      body: {
        session_token: token,
        expires_at: Math.floor(Date.now() / 1000) + this.sessionSeconds,
        principal: {
          space_id: this.id,
          member_id: identity.memberId,
          device_id: identity.deviceId,
          role: "owner",
        },
      },
    };
  }
  attach(options: NativeTlsOptions, send: (event: TlsEvent) => void) {
    const identity = this.tokens.get(
      (options.headers.Authorization ?? "").replace(/^Bearer /u, ""),
    );
    let closed = false;
    const peer = {
      emit: (envelope: MobileEnvelope) =>
        deliver(() => {
          if (!closed) send({ type: "message", text: JSON.stringify(envelope) });
        }),
      close: (code: number) => {
        if (closed) return;
        closed = true;
        this.peers.delete(peer);
        deliver(() => send({ type: "close", code }));
      },
    };
    if (!identity || this.revoked) {
      deliver(() => send({ type: "error", code: "transport" }));
      return { close: () => {}, send: () => {} };
    }
    this.peers.add(peer);
    deliver(() => {
      send({ type: "open" });
      if (this.allowHello)
        peer.emit({
          t: "hello",
          d: {
            protocol: this.protocol,
            spaceId: this.id,
            spaceKind: this.spaceKind,
            memberId: identity.memberId,
            host: {
              id: spaceMemberKey(this.id, identity.memberId),
              name: this.id,
              platform: "host",
              appVersion: "1",
            },
            deviceId: identity.deviceId,
            routes: this.routes,
          },
        });
    });
    return {
      close: () => peer.close(1000),
      send: (bytes: Uint8Array) =>
        deliver(() => {
          if (closed) return;
          const envelope = MobileEnvelopeSchema.parse(JSON.parse(decodeUtf8(bytes)));
          if (envelope.t === "ping" && this.pong) peer.emit({ t: "pong" });
          if (envelope.t !== "req") return;
          this.requests.push(envelope);
          this.admissions.push({ memberId: identity.memberId, request: envelope });
          this.onRequest(
            envelope,
            (r) => peer.emit({ t: "res", id: envelope.id, ok: true, r }),
            (message, retryable, code = retryable ? "unavailable" : "rejected") =>
              peer.emit({ t: "res", id: envelope.id, ok: false, e: { code, message, retryable } }),
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
      space_id: this.id,
      space_name: this.id,
      member_id: this.memberId,
      fingerprint: this.fingerprint,
      routes,
      code: "device-link-code",
      expires_at: Math.floor(expiresAt / 1000),
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
  const tlsListeners = new Map<string, (event: TlsEvent) => void>();
  const operations = new Map<string, { close(): void; send?(bytes: Uint8Array): void }>();
  const starts: { id: string; options: NativeTlsOptions; socket: boolean }[] = [];
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
  const start = (id: string, options: NativeTlsOptions, socket: boolean) => {
    starts.push({ id, options, socket });
    const url = new URL(options.url);
    url.protocol = "https:";
    const route = `${url.origin}/`;
    const target = routes.get(route);
    const dial = { route, at: Date.now(), closed: false };
    if (socket) dials.push(dial);
    const emit = (event: TlsEvent) => tlsListeners.get(id)?.(event);
    const timer = setTimeout(() => emit({ type: "error", code: "timeout" }), options.timeoutMs);
    operations.set(id, {
      close() {
        clearTimeout(timer);
        dial.closed = true;
      },
    });
    deliver(() => {
      if (!operations.has(id) || target === "stall") return;
      clearTimeout(timer);
      if (typeof target === "number") return emit({ type: "close", code: target });
      if (!target || target === "unreachable") return emit({ type: "error", code: "transport" });
      if (options.fingerprint !== target.fingerprint) return emit({ type: "error", code: "pin" });
      if (socket) {
        const peer = target.attach(options, emit);
        operations.set(id, {
          close() {
            dial.closed = true;
            peer.close();
          },
          send: peer.send,
        });
        return;
      }
      const response = target.http(
        new URL(options.url).pathname,
        JSON.parse(decodeUtf8(fromBase64(options.body))),
      );
      emit({
        type: "response",
        status: response.status,
        headers: {},
        body: toBase64(encodeUtf8(JSON.stringify(response.body))),
      });
    });
  };
  const native = {
    listen: (id: string, listener: (event: TlsEvent) => void) => {
      tlsListeners.set(id, listener);
      return () => {
        tlsListeners.delete(id);
      };
    },
    startRequest: (id: string, options: NativeTlsOptions) => start(id, options, false),
    openSocket: (id: string, options: NativeTlsOptions) => start(id, options, true),
    send: (id: string, body: string, binary: boolean) => {
      const operation = operations.get(id);
      if (!operation?.send) throw new Error("Socket closed");
      operation.send(binary ? fromBase64(body) : encodeUtf8(body));
    },
    cancel: (id: string) => {
      operations.get(id)?.close();
      operations.delete(id);
    },
  };
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
    starts,
    storage: keyValue(data),
    secrets: keyValue(secrets),
    pinnedTls: makePinnedTls(native),
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
    data: typeof data;
    savedSecrets: typeof secrets;
    contents: typeof files;
    routes: typeof routes;
    dials: typeof dials;
    compression: typeof compression;
    starts: typeof starts;
    setForeground(value: boolean): void;
  };
  return platform;
}
