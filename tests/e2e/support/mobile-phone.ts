import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import {
  beginHandshake,
  generateStaticKeyPair,
  MOBILE_PROTOCOL_REVISION,
  MobileEnvelopeSchema,
  mobileEvents,
  mobileMethods,
  parsePairingUri,
  type ChatSnapshot,
  type Hello,
  type MobileEnvelope,
  type MobileEventData,
  type MobileMethod,
  type MobileParams,
  type MobileResult,
  type PairingOffer,
  type SecureChannel,
  type StaticKeyPair,
} from "@nodex/mobile-protocol";

const bytes = (length: number) => new Uint8Array(randomBytes(length));
const decodeKey = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEADLINE_MS = 15_000;

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
};

export class PhoneConnectionClosed extends Error {
  constructor(readonly code: number) {
    super(`Phone connection closed (${code})`);
  }
}

/** Retains the same phone key for pairing, reconnecting, and checking revocation. */
export class MobilePhone {
  private constructor(
    readonly offer: PairingOffer,
    private readonly device: StaticKeyPair,
  ) {}

  static fromCopiedLink(uri: string): MobilePhone {
    const offer = parsePairingUri(uri);
    if (!offer) throw new Error("Copy link did not put a mobile pairing link on the clipboard");
    return new MobilePhone(offer, generateStaticKeyPair(bytes));
  }

  async connect(pairing = false): Promise<PhoneChannel> {
    // Use an advertised route, including its real listener port. Never discover gateway internals.
    const route =
      this.offer.routes.find((route) => new URL(route).hostname === "127.0.0.1") ??
      this.offer.routes[0]!;
    return PhoneChannel.connect(
      route,
      this.offer.hostKey,
      this.device,
      pairing ? decodeKey(this.offer.secret) : undefined,
    );
  }
}

/** Test-only transport peer: no gateway, Core, Runtime, or snapshot mocks. */
export class PhoneChannel {
  private readonly ready = deferred<Hello>();
  private readonly ended = deferred<number>();
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly chats = new Map<string, ChatSnapshot>();
  private readonly patches: MobileEventData<"chat.patch">[] = [];
  private channel: SecureChannel | null = null;
  private failure: Error | null = null;
  private nextId = 1;
  private closeCode: number | null = null;
  readonly hello: Promise<Hello>;

  private constructor(
    private readonly socket: WebSocket,
    hostKey: string,
    device: StaticKeyPair,
    psk?: Uint8Array,
  ) {
    this.hello = this.ready.promise;
    const handshake = beginHandshake({
      hostPublicKey: decodeKey(hostKey),
      device,
      ...(psk ? { psk } : {}),
      payload: encoder.encode(
        JSON.stringify({
          protocol: MOBILE_PROTOCOL_REVISION,
          deviceName: "Gateway test phone",
          platform: "ios",
          appVersion: "e2e",
        }),
      ),
      randomBytes: bytes,
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", (code) => {
      this.closeCode = code;
      this.ended.resolve(code);
      this.fail(new PhoneConnectionClosed(code));
    });
    socket.on("message", (data, binary) => {
      try {
        if (!binary) throw new Error("The gateway sent an unencrypted text frame");
        const frame = new Uint8Array(data as Buffer);
        if (!this.channel) {
          this.channel = handshake.finish(frame).channel;
          this.send({ t: "ping" });
          return;
        }
        const opened = this.channel.open(frame);
        if (!opened) return;
        this.receive(MobileEnvelopeSchema.parse(JSON.parse(decoder.decode(opened))));
      } catch (cause) {
        this.fail(cause instanceof Error ? cause : new Error(String(cause)));
        socket.close();
      }
    });
    socket.once("open", () => socket.send(handshake.message));
  }

  static async connect(route: string, hostKey: string, device: StaticKeyPair, psk?: Uint8Array) {
    const phone = new PhoneChannel(new WebSocket(route), hostKey, device, psk);
    try {
      await phone.deadline(phone.hello, "authenticated hello");
      return phone;
    } catch (error) {
      await phone.close();
      throw error;
    }
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.ready.reject(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private async deadline<Value>(promise: Promise<Value>, label: string): Promise<Value> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Phone timed out waiting for ${label}`)),
            DEADLINE_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private send(envelope: MobileEnvelope) {
    if (!this.channel) throw new Error("Phone channel is not authenticated");
    for (const frame of this.channel.seal(encoder.encode(JSON.stringify(envelope))))
      this.socket.send(frame);
  }

  private receive(envelope: MobileEnvelope) {
    if (envelope.t === "hello") {
      if (envelope.d.protocol !== MOBILE_PROTOCOL_REVISION)
        throw new Error("The gateway negotiated a different protocol revision");
      this.ready.resolve(envelope.d);
      return;
    }
    if (envelope.t === "res") {
      const request = this.pending.get(envelope.id);
      if (!request) throw new Error(`Unsolicited phone response ${envelope.id}`);
      this.pending.delete(envelope.id);
      if (!envelope.ok) {
        request.reject(new Error(`Mobile RPC ${envelope.e.code}: ${envelope.e.message}`));
        return;
      }
      request.resolve(envelope.r);
      return;
    }
    if (envelope.t !== "evt") return;
    if (!Object.hasOwn(mobileEvents, envelope.k))
      throw new Error(`Unknown mobile event ${envelope.k}`);
    const kind = envelope.k as keyof typeof mobileEvents;
    const data = mobileEvents[kind].parse(envelope.d);
    if (kind === "chat.snapshot") {
      const snapshot = mobileEvents["chat.snapshot"].parse(data);
      this.chats.set(snapshot.sessionId, snapshot);
      return;
    }
    if (kind !== "chat.patch") return;
    const patch = mobileEvents["chat.patch"].parse(data);
    this.patches.push(patch);
    this.apply(patch);
  }

  private apply(patch: MobileEventData<"chat.patch">) {
    const snapshot = this.chats.get(patch.sessionId);
    if (!snapshot || patch.revision <= snapshot.revision) return;
    if (patch.revision !== snapshot.revision + 1)
      throw new Error(`Phone missed chat revision ${snapshot.revision + 1}`);
    for (const op of patch.ops) {
      if (op.op === "state") snapshot.state = op.state;
      if (op.op === "title") snapshot.title = op.title;
      if (op.op === "remove")
        snapshot.items = snapshot.items.filter((item) => item.id !== op.itemId);
      if (op.op === "upsert") {
        const index = snapshot.items.findIndex((item) => item.id === op.item.id);
        if (index < 0) snapshot.items.push(op.item);
        else snapshot.items[index] = op.item;
      }
      if (op.op !== "append") continue;
      const item = snapshot.items.find((item) => item.id === op.itemId);
      if (
        !item ||
        (item.kind !== "assistant" && item.kind !== "thinking") ||
        item.text.length !== op.offset
      )
        throw new Error(`Phone received a text append at an invalid offset (${op.itemId})`);
      item.text += op.text;
    }
    snapshot.revision = patch.revision;
  }

  async request<Method extends MobileMethod>(
    method: Method,
    params: MobileParams<Method>,
  ): Promise<MobileResult<Method>> {
    this.assertHealthy();
    const id = this.nextId++;
    const response = deferred<unknown>();
    this.pending.set(id, response);
    try {
      this.send({ t: "req", id, m: method, p: mobileMethods[method].params.parse(params) });
      const value = await this.deadline(response.promise, method);
      return mobileMethods[method].result.parse(value) as MobileResult<Method>;
    } finally {
      this.pending.delete(id);
    }
  }

  async openChat(sessionId: string): Promise<ChatSnapshot> {
    const start = this.patches.length;
    const snapshot = await this.request("chat.open", { sessionId });
    this.chats.set(sessionId, snapshot);
    for (const patch of this.patches.slice(start)) this.apply(patch);
    return snapshot;
  }

  chat(sessionId: string): ChatSnapshot {
    this.assertHealthy();
    const snapshot = this.chats.get(sessionId);
    if (!snapshot) throw new Error(`Chat ${sessionId} was not opened`);
    return snapshot;
  }

  patchCount(sessionId: string): number {
    this.assertHealthy();
    return this.patches.filter((patch) => patch.sessionId === sessionId).length;
  }

  diagnostics() {
    return {
      failure: this.failure?.message,
      chats: [...this.chats.values()],
      patches: this.patches,
    };
  }

  private assertHealthy() {
    if (this.failure) throw this.failure;
  }

  async waitForClose(): Promise<number> {
    return this.deadline(this.ended.promise, "connection close");
  }

  async close(): Promise<void> {
    if (this.closeCode !== null) return;
    this.socket.close();
    try {
      await this.waitForClose();
    } catch {
      this.socket.terminate();
    }
  }
}
