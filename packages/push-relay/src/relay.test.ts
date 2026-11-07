import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import {
  createServer,
  constants,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
} from "node:http2";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  RelayDeviceRequestSchema,
  RelayPushRequestSchema,
  sealPushPayload,
} from "@nodex/mobile-protocol";
import { apnsOrigin, createProviderToken } from "./apns.js";
import { createHandles } from "./handles.js";
import { createHandler, createRelay } from "./relay.js";
import {
  MAX_BODY_BYTES,
  MAX_APNS_BYTES,
  pushBody,
  validateDevice,
  validatePush,
  type Device,
} from "./validation.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credentials = {
  privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  keyId: "ABC123DE45",
  teamId: "8HGUT3HC4Z",
};
const env = {
  PUSH_RELAY_SEAL_KEY: randomBytes(32).toString("base64"),
  APNS_KEY_P8: credentials.privateKey,
  APNS_KEY_ID: credentials.keyId,
  APNS_TEAM_ID: credentials.teamId,
};
const device: Device = {
  token: "ab".repeat(32),
  environment: "sandbox",
  bundleId: "app.jyu.nodex.mobile.dev",
};
const sealed = sealPushPayload(randomBytes(32), randomBytes(12), {
  kind: "needs_you",
  sessionId: "session-1",
  title: "Approval needed",
  body: "Allow this command?",
});
const handles = createHandles(env.PUSH_RELAY_SEAL_KEY);
const push = { handle: handles.seal(device), sealed, urgency: "time-sensitive" as const };

describe("device handles", () => {
  it("round trips both environments and topics without exposing the token", () => {
    for (const environment of ["sandbox", "production"] as const) {
      for (const bundleId of ["app.jyu.nodex.mobile", "app.jyu.nodex.mobile.dev"]) {
        const registration = { ...device, environment, bundleId };
        const handle = handles.seal(registration);
        expect(handles.open(handle)).toEqual(registration);
        expect(handle).not.toContain(registration.token);
        expect(handles.seal(registration)).not.toBe(handle);
      }
    }
  });

  it("rejects tampering in the version, nonce, tag and ciphertext, truncation, and another key", () => {
    const original = handles.seal(device);
    for (const offset of [0, 1, 13, 29]) {
      const bytes = Buffer.from(original, "base64url");
      bytes[offset] = bytes[offset]! ^ 1;
      expect(handles.open(bytes.toString("base64url"))).toBeNull();
    }
    for (const invalid of ["", "a", original.slice(0, -8), `${original}=`, "!", "a".repeat(1025)]) {
      expect(handles.open(invalid)).toBeNull();
    }
    expect(createHandles(randomBytes(32).toString("base64")).open(original)).toBeNull();
  });

  it("rejects unapproved topics and malformed seal keys", () => {
    expect(() => handles.seal({ ...device, bundleId: "other.app" })).toThrow("BundleNotAllowed");
    for (const invalid of [
      "",
      "!".repeat(44),
      randomBytes(31).toString("base64"),
      env.PUSH_RELAY_SEAL_KEY + "=",
    ]) {
      expect(() => createHandles(invalid)).toThrow("Invalid PUSH_RELAY_SEAL_KEY");
    }
  });
});

describe("hand validation matches the shared wire grammar", () => {
  it("accepts shared device requests, including token boundaries and loose fields", () => {
    for (const token of ["A".repeat(32), "f".repeat(200), "0".repeat(33)]) {
      for (const environment of ["sandbox", "production"]) {
        for (const bundleId of [device.bundleId, "app.jyu.nodex.mobile", "", "other.app"]) {
          const value = { token, environment, bundleId, futureField: true };
          expect(RelayDeviceRequestSchema.safeParse(value).success).toBe(true);
          expect(validateDevice(value)).toEqual({ token, environment, bundleId });
        }
      }
    }
  });

  it("accepts shared push requests without interpreting the ciphertext", () => {
    for (const handle of ["", push.handle]) {
      for (const value of ["", sealed, 'opaque-"-🔐']) {
        for (const urgency of ["active", "time-sensitive"]) {
          const request = { handle, sealed: value, urgency, futureField: 1 };
          expect(RelayPushRequestSchema.safeParse(request).success).toBe(true);
          expect(validatePush(request)).toEqual({ handle, sealed: value, urgency });
        }
      }
    }
  });

  it.each(
    [
      null,
      [],
      "device",
      {},
      { ...device, token: 1 },
      { ...device, token: "a".repeat(31) },
      { ...device, token: "f".repeat(201) },
      { ...device, token: "g".repeat(64) },
      { ...device, environment: "dev" },
      { ...device, bundleId: null },
    ].map((value) => ({ value })),
  )("rejects invalid device fields", ({ value }) => {
    expect(RelayDeviceRequestSchema.safeParse(value).success).toBe(false);
    expect(validateDevice(value)).toBeNull();
  });

  it.each(
    [
      null,
      [],
      "push",
      {},
      { ...push, handle: null },
      { ...push, sealed: 1 },
      { ...push, urgency: "critical" },
      { ...push, urgency: undefined },
    ].map((value) => ({ value })),
  )("rejects invalid push fields", ({ value }) => {
    expect(RelayPushRequestSchema.safeParse(value).success).toBe(false);
    expect(validatePush(value)).toBeNull();
  });
});

describe("APNs provider tokens", () => {
  it("signs ES256 in JWT's compact format and reuses the token for 45 minutes", () => {
    let now = 1_800_000_000_000;
    const getToken = createProviderToken(credentials, () => now);
    const first = getToken();
    const [header, claims, signature] = first.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: credentials.keyId,
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      iss: credentials.teamId,
      iat: now / 1000,
    });
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    now += 45 * 60_000 - 1000;
    expect(getToken()).toBe(first);
    now += 1000;
    const renewed = getToken();
    expect(renewed).not.toBe(first);
    now -= 2000;
    expect(getToken()).not.toBe(renewed);
  });
});

describe("relay HTTP handlers with a real HTTP/2 APNs peer", () => {
  const sessions = new Set<ServerHttp2Session>();
  let server: ReturnType<typeof createServer>;
  let relay: ReturnType<typeof createRelay>;
  let devices: ReturnType<typeof createHandler>;
  let notify: ReturnType<typeof createHandler>;
  let response: { status: number; body: string; mode?: "reset" | "hang" | "oversize" };
  let requests: { headers: IncomingHttpHeaders; body: string }[];
  let now: number;
  const log = vi.fn();
  const origin = vi.fn();

  const post = (handler: typeof devices, body: unknown) =>
    handler(
      new Request("https://push.nodex.jyu.app/v1/test", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );

  beforeEach(async () => {
    requests = [];
    response = { status: 200, body: "" };
    now = 1_800_000_000_000;
    log.mockClear();
    origin.mockReset();
    server = createServer();
    server.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
      session.on("error", () => {});
    });
    server.on("stream", (stream, headers) => {
      stream.on("error", () => {});
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => {
        requests.push({ headers, body });
        if (response.mode === "hang") return;
        if (response.mode === "reset") {
          stream.close(constants.NGHTTP2_INTERNAL_ERROR);
          return;
        }
        stream.respond({ ":status": response.status });
        stream.end(response.mode === "oversize" ? "x".repeat(8193) : response.body);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP/2 test port");
    origin.mockReturnValue(`http://127.0.0.1:${address.port}`);
    relay = createRelay(env, { origin, now: () => now, timeoutMs: 5_000, log });
    devices = createHandler("devices", () => relay);
    notify = createHandler("push", () => relay);
  });

  afterEach(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(["sandbox", "production"] as const)(
    "registers and sends one encrypted alert to %s",
    async (environment) => {
      const registration = { ...device, environment };
      const registered = await post(devices, registration);
      expect(registered.status).toBe(200);
      const { handle } = await registered.json();
      expect(handles.open(handle)).toEqual(registration);
      const result = await post(notify, { ...push, handle });
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ ok: true });
      expect(requests).toHaveLength(1);
      expect(origin).toHaveBeenCalledWith(environment);
      expect(apnsOrigin(environment)).toBe(
        environment === "production"
          ? "https://api.push.apple.com"
          : "https://api.sandbox.push.apple.com",
      );
      expect(requests[0]!.headers).toMatchObject({
        ":method": "POST",
        ":path": `/3/device/${device.token}`,
        "apns-topic": device.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        authorization: expect.stringMatching(/^bearer [A-Za-z0-9_.-]+$/u),
      });
      expect(JSON.parse(requests[0]!.body)).toEqual({
        aps: {
          alert: { title: "Nodex", body: "You have an update." },
          "mutable-content": 1,
          sound: "default",
          "interruption-level": "time-sensitive",
        },
        n: sealed,
      });
      expect(requests[0]!.body).not.toContain("Approval needed");
      expect(log.mock.calls).toEqual([[{ status: 200, reason: null }]]);
    },
  );

  it("reuses the JWT across HTTP/2 requests until renewal", async () => {
    await post(notify, push);
    now += 44 * 60_000;
    await post(notify, push);
    now += 60_000;
    await post(notify, push);
    expect(requests[1]!.headers.authorization).toBe(requests[0]!.headers.authorization);
    expect(requests[2]!.headers.authorization).not.toBe(requests[0]!.headers.authorization);
  });

  it.each([
    [410, "Unregistered", 410, { gone: true }],
    [400, "BadDeviceToken", 410, { gone: true }],
    [400, "DeviceTokenNotForTopic", 410, { gone: true }],
    [429, "TooManyRequests", 429, { reason: "TooManyRequests" }],
    [500, "InternalServerError", 503, { reason: "InternalServerError" }],
    [503, "Shutdown", 503, { reason: "Shutdown" }],
    [400, "BadTopic", 400, { reason: "BadTopic" }],
    [403, "InvalidProviderToken", 403, { reason: "InvalidProviderToken" }],
    [413, "PayloadTooLarge", 413, { reason: "PayloadTooLarge" }],
    [404, "BadPath", 404, { reason: "BadPath" }],
  ])("maps APNs %i %s to %i", async (status, reason, expectedStatus, expectedBody) => {
    response = { status, body: JSON.stringify({ reason }) };
    const result = await post(notify, push);
    expect(result.status).toBe(expectedStatus);
    expect(await result.json()).toEqual(expectedBody);
    expect(requests).toHaveLength(1);
    expect(log.mock.calls).toEqual([[{ status, reason }]]);
    if (expectedStatus === 429 || expectedStatus === 503)
      expect(result.headers.get("retry-after")).toBe("60");
  });

  it.each(["reset", "hang", "oversize"] as const)(
    "maps a transport %s to a retryable 503",
    async (mode) => {
      response.mode = mode;
      if (mode === "hang") {
        notify = createHandler("push", () => createRelay(env, { origin, timeoutMs: 1000, log }));
      }
      const result = await post(notify, push);
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ reason: "ApnsTransportFailure" });
      expect(log.mock.calls).toEqual([[{ status: 503, reason: null }]]);
      expect(requests).toHaveLength(1);
    },
  );

  it("maps connection refusal to 503", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect((await post(notify, push)).status).toBe(503);
    expect(requests).toHaveLength(0);
  });

  it.each([
    "not JSON",
    JSON.stringify({ reason: push.handle }),
    JSON.stringify({ reason: sealed }),
  ])("never echoes or logs an unrecognized APNs body", async (body) => {
    response = { status: 400, body };
    const result = await post(notify, push);
    expect(await result.json()).toEqual({ reason: "ApnsRejected" });
    expect(log.mock.calls).toEqual([[{ status: 400, reason: null }]]);
  });

  it("rejects another bundle, invalid fields and an unopenable handle before APNs", async () => {
    expect(await (await post(devices, { ...device, bundleId: "other.app" })).json()).toEqual({
      reason: "BundleNotAllowed",
    });
    expect((await post(devices, { ...device, token: false })).status).toBe(400);
    expect((await post(notify, { ...push, urgency: "critical" })).status).toBe(400);
    const invalid = await post(notify, { ...push, handle: "tampered" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ reason: "InvalidHandle" });
    expect(requests).toHaveLength(0);
  });

  it.each(["active", "time-sensitive"] as const)(
    "enforces the APNs byte boundary for %s",
    async (urgency) => {
      const empty = { ...push, sealed: "", urgency };
      const available = MAX_APNS_BYTES - Buffer.byteLength(pushBody(empty));
      const atLimit = { ...empty, sealed: "a".repeat(available) };
      expect((await post(notify, atLimit)).status).toBe(200);
      expect(Buffer.byteLength(requests[0]!.body)).toBe(MAX_APNS_BYTES);
      for (const value of [
        "a".repeat(available + 1),
        "🔐".repeat(Math.ceil(available / 4)),
        '"'.repeat(available),
      ]) {
        const result = await post(notify, { ...empty, sealed: value });
        expect(result.status).toBe(413);
        expect(await result.json()).toEqual({ reason: "PayloadTooLarge" });
      }
      expect(requests).toHaveLength(1);
    },
  );

  it("enforces 8 KB of raw bytes, including ignored fields and chunked bodies", async () => {
    const raw = JSON.stringify(device);
    const atLimit = raw + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(raw));
    expect(
      (
        await devices(
          new Request("https://push.nodex.jyu.app/v1/devices", { method: "POST", body: atLimit }),
        )
      ).status,
    ).toBe(200);
    const oversized = atLimit + " ";
    expect(
      (
        await devices(
          new Request("https://push.nodex.jyu.app/v1/devices", { method: "POST", body: oversized }),
        )
      ).status,
    ).toBe(413);
    expect((await post(devices, { ...device, ignored: "🔐".repeat(2100) })).status).toBe(413);
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(atLimit));
        controller.enqueue(Buffer.from(" "));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://push.nodex.jyu.app/v1/devices", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const result = await devices(request);
    expect(await result.json()).toEqual({ reason: "BodyTooLarge" });
    expect(cancelled).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("rejects declared oversized bodies, invalid JSON, invalid UTF-8, and non-POST methods", async () => {
    const declared = await devices(
      new Request("https://push.nodex.jyu.app/v1/devices", {
        method: "POST",
        body: "{}",
        headers: { "content-length": "8193" },
      }),
    );
    expect(declared.status).toBe(413);
    for (const body of ["{", new Uint8Array([0xff]), null]) {
      const result = await devices(
        new Request("https://push.nodex.jyu.app/v1/devices", { method: "POST", body }),
      );
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ reason: "InvalidJson" });
    }
    const get = await notify(new Request("https://push.nodex.jyu.app/v1/push"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(get.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a sanitized retryable response when secrets are missing", async () => {
    const handler = createHandler("push", () => createRelay({}));
    const result = await post(handler, push);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ reason: "RelayUnavailable" });
    expect(requests).toHaveLength(0);
  });

  it("registers with only a seal key but needs APNs credentials to deliver", async () => {
    const registrationOnly = createRelay({ PUSH_RELAY_SEAL_KEY: env.PUSH_RELAY_SEAL_KEY });
    const register = createHandler("devices", () => registrationOnly);
    const registered = await post(register, device);
    expect(registered.status).toBe(200);
    const { handle } = await registered.json();
    expect(handles.open(handle)).toEqual(device);
    const deliver = createHandler("push", () => registrationOnly);
    const result = await post(deliver, { ...push, handle });
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ reason: "RelayUnavailable" });
    expect(requests).toHaveLength(0);
  });
});
