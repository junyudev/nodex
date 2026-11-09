import { createHash, timingSafeEqual } from "node:crypto";
import { Agent, request as requestHttps, type RequestOptions } from "node:https";
import { connect } from "node:tls";
import type { Duplex } from "node:stream";
import { enrollRemoteCore } from "../../../src/main/core-client/remote-http";
import { WebSocket } from "ws";
import {
  MOBILE_PROTOCOL_REVISION,
  MobileEnvelopeSchema,
  mobileEvents,
  mobileMethods,
  parseDeviceLinkUri,
  type DeviceLinkOffer,
  type ChatSnapshot,
  type Hello,
  type MobileEnvelope,
  type MobileEventData,
  type MobileMethod,
  type MobileParams,
  type MobileResult,
} from "@nodex/mobile-protocol";

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

/** TLS authenticates the full leaf DER before HTTP can write a credential or application byte. */
class PinnedAgent extends Agent {
  constructor(private readonly fingerprint: string) {
    super({ maxCachedSessions: 0 });
  }
  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): undefined {
    const socket = connect({
      host: options.hostname ?? options.host ?? "localhost",
      port: Number(options.port ?? 443),
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    const timer = setTimeout(() => socket.destroy(new Error("TLS deadline")), 5000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      callback?.(error, socket);
    });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const raw = socket.getPeerCertificate().raw;
      if (
        !raw ||
        !timingSafeEqual(
          createHash("sha256").update(raw).digest(),
          Buffer.from(this.fingerprint, "hex"),
        )
      ) {
        socket.destroy(new Error("Certificate pin mismatch"));
        return;
      }
      callback?.(null, socket);
    });
    return undefined;
  }
}

/** Retains only the Device credential issued for this exact Space and Member. */
export class MobilePhone {
  private credential: string | null = null;
  private constructor(readonly offer: DeviceLinkOffer) {}
  static fromCopiedLink(uri: string): MobilePhone {
    const offer = parseDeviceLinkUri(uri);
    if (!offer) throw new Error("Invalid Device link");
    return new MobilePhone(offer);
  }
  async connect(enroll = false): Promise<PhoneChannel> {
    const route =
      this.offer.routes.find((route) => new URL(route).hostname === "127.0.0.1") ??
      this.offer.routes[0]!;
    if (enroll) {
      const device = await enrollRemoteCore(
        { url: route, fingerprint: this.offer.fingerprint },
        {
          code: this.offer.code,
          device_label: "Test phone",
          display_name: "Phone",
          form_factor: "phone",
        },
      );
      if (device.space_id !== this.offer.space_id || device.member_id !== this.offer.member_id)
        throw new Error("Enrollment identity mismatch");
      this.credential = device.device_credential;
    }
    if (!this.credential) throw new Error("Device is not enrolled");
    const agent = new PinnedAgent(this.offer.fingerprint);
    const session = await new Promise<{ session_token: string }>((resolve, reject) => {
      const req = requestHttps(
        new URL("/session", route),
        { method: "POST", agent, headers: { "content-type": "application/json" } },
        (res) => {
          let body = "";
          res.on("data", (data: Buffer) => {
            body += data.toString();
          });
          res.once("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Device renewal refused (${res.statusCode})`));
              return;
            }
            resolve(JSON.parse(body));
          });
          res.once("error", reject);
        },
      );
      req.once("error", reject);
      req.end(JSON.stringify({ device_credential: this.credential }));
    }).finally(() => agent.destroy());
    const phone = await PhoneChannel.connect(
      new URL("/core/v1/phone", route).toString().replace("https:", "wss:"),
      this.offer.fingerprint,
      session.session_token,
    );
    const hello = await phone.hello;
    if (hello.spaceId !== this.offer.space_id || hello.memberId !== this.offer.member_id) {
      await phone.close();
      throw new Error("Channel identity mismatch");
    }
    return phone;
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
  private failure: Error | null = null;
  private nextId = 1;
  private closeCode: number | null = null;
  readonly hello: Promise<Hello>;

  private constructor(private readonly socket: WebSocket) {
    this.hello = this.ready.promise;
    socket.on("error", (error) => this.fail(error));
    socket.on("close", (code) => {
      this.closeCode = code;
      this.ended.resolve(code);
      this.fail(new PhoneConnectionClosed(code));
    });
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Phone protocol requires text envelopes");
        this.receive(MobileEnvelopeSchema.parse(JSON.parse(data.toString())));
      } catch (cause) {
        this.fail(cause instanceof Error ? cause : new Error(String(cause)));
        socket.close();
      }
    });
  }

  static async connect(route: string, fingerprint: string, token: string) {
    const agent = new PinnedAgent(fingerprint);
    const socket = new WebSocket(route, {
      agent,
      headers: { authorization: `Bearer ${token}` },
      maxPayload: 1024 * 1024,
    });
    socket.once("close", () => agent.destroy());
    const phone = new PhoneChannel(socket);
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
    this.socket.send(JSON.stringify(envelope));
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
        request.reject(
          Object.assign(new Error(`Mobile RPC ${envelope.e.code}: ${envelope.e.message}`), {
            code: envelope.e.code,
            retryable: envelope.e.retryable,
          }),
        );
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
