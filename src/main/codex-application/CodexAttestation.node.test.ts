import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  buildCodexAttestationSignals,
  encodeCodexAttestationToken,
  makeCodexAttestation,
  supportsCodexAttestationRequests,
} from "./CodexAttestation";

const signals = buildCodexAttestationSignals({
  appSessionId: "session-123",
  displayHeight: 900,
  displayWidth: 1600,
  locale: "en-US",
  preferredLanguages: ["en-US", "zh-CN"],
  screenScale: 2,
  timezone: "America/Los_Angeles",
});

it("matches desktop attestation capability support", () => {
  assert.isTrue(supportsCodexAttestationRequests("darwin"));
  assert.isTrue(supportsCodexAttestationRequests("win32"));
  assert.isFalse(supportsCodexAttestationRequests("linux"));
});

it("bounds attestation signals before serialization", () => {
  const bounded = buildCodexAttestationSignals({
    appSessionId: "s".repeat(200),
    displayHeight: 900.2,
    displayWidth: 1599.7,
    locale: "",
    preferredLanguages: Array.from({ length: 20 }, (_, index) => `${index}-${"x".repeat(100)}`),
    screenScale: 1.5,
    timezone: "z".repeat(100),
  });
  assert.strictEqual(bounded.schemaVersion, 1);
  assert.strictEqual(bounded.locale, "unknown");
  assert.strictEqual(bounded.preferredLanguages.length, 16);
  assert.strictEqual(bounded.preferredLanguages[0]?.length, 64);
  assert.strictEqual(bounded.timezone.length, 64);
  assert.strictEqual(bounded.screenSizeSum, 2500);
  assert.strictEqual(bounded.screenScale, 1.5);
  assert.strictEqual(bounded.appSessionId.length, 128);
});

it("encodes the wire token with deterministic CBOR field order", () => {
  assert.strictEqual(
    encodeCodexAttestationToken({
      bundleIdentifier: "app.jyu.nodex",
      errorCode: 2,
      signals,
      latencyMs: 1.5,
    }),
    "v1.pGplcnJvcl9jb2RlAmlidW5kbGVfaWRtYXBwLmp5dS5ub2RleGFmWECnAAEBgmVlbi1VU2V6aC1DTgJlZW4tVVMDc0FtZXJpY2EvTG9zX0FuZ2VsZXMEGQnEBQIGa3Nlc3Npb24tMTIzYXT7P_gAAAAAAAA",
  );
});

it("always encodes DeviceCheck latency as float64", () => {
  const token = encodeCodexAttestationToken({
    bundleIdentifier: "app.jyu.nodex",
    errorCode: 3,
    latencyMs: 11,
  });
  const payload = Buffer.from(token.slice(3), "base64url");
  const latencyKey = payload.indexOf(Buffer.from("t"));
  assert.isTrue(latencyKey >= 0);
  assert.strictEqual(payload[latencyKey + 1], 0xfb);
});

it.effect("returns the native DeviceCheck token on Apple silicon", () =>
  Effect.gen(function* () {
    const attestation = makeCodexAttestation({
      platform: "darwin",
      architecture: "arm64",
      bundleIdentifier: "app.jyu.nodex",
      getSignals: () => signals,
      generateDeviceCheckToken: () =>
        Promise.resolve({ supported: true, tokenBase64: "device-token", latencyMs: 7.25 }),
    });
    const response = yield* attestation.generate;
    assert.isTrue(response.token.startsWith("v1."));
    const payload = Buffer.from(response.token.slice(3), "base64url");
    assert.isTrue(payload.includes(Buffer.from("device-token")));
    assert.isTrue(payload.includes(Buffer.from("app.jyu.nodex")));
  }),
);

it.effect("returns protocol error tokens for unsupported desktop combinations", () =>
  Effect.gen(function* () {
    const linux = makeCodexAttestation({
      platform: "linux",
      architecture: "x64",
      bundleIdentifier: "app.jyu.nodex",
      getSignals: () => {
        throw new Error("unsupported platforms do not collect signals");
      },
    });
    const intelMac = makeCodexAttestation({
      platform: "darwin",
      architecture: "x64",
      bundleIdentifier: "app.jyu.nodex",
      getSignals: () => signals,
    });
    const linuxToken = (yield* linux.generate).token;
    const intelToken = (yield* intelMac.generate).token;
    assert.isTrue(
      Buffer.from(linuxToken.slice(3), "base64url").includes(Buffer.from("error_code")),
    );
    assert.isFalse(
      Buffer.from(linuxToken.slice(3), "base64url").includes(Buffer.from("session-123")),
    );
    assert.isTrue(
      Buffer.from(intelToken.slice(3), "base64url").includes(Buffer.from("session-123")),
    );
  }),
);
