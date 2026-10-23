// @effect-diagnostics strictEffectProvide:off
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { make as makeAccount } from "../../nodex-account/NodexAccount";
import { NodexAccountPlatform } from "../NodexAccountPlatform";
import { SecretEncryption } from "../SecretEncryption";
import {
  make,
  parseNodexAccountCallback,
  resolveNodexAccountConfiguration,
  type NodexAccountHost,
} from "./NodexAccountPlatform";

const redirectUri = "http://127.0.0.1:12345/callback";
const callback = (url: string) =>
  parseNodexAccountCallback({
    method: "GET",
    host: "127.0.0.1:12345",
    redirectUri,
    state: "abcd",
    url,
  });
it("rejects malformed and Unicode callback state without consuming a valid attempt", () => {
  for (const url of [
    "/callback?state=éééé&code=one",
    "/callback?state=abcd&state=abcd&code=one",
    "http://wrong.example/callback?state=abcd&code=one",
    "http://[",
    "/callback?state=abcd&code=one&error=denied",
  ])
    expect(callback(url).kind).toBe("invalid");
  expect(callback("/callback?state=abcd&code=one")).toEqual({ kind: "code", code: "one" });
});
it("requires both an unpackaged build and explicit fixture flag for an HTTP issuer", () => {
  const host: NodexAccountHost = {
    home: "/tmp/profile",
    isPackaged: false,
    environment: { NODEX_CLERK_ISSUER: "http://127.0.0.1:6789", NODEX_CLERK_CLIENT_ID: "client" },
    openExternal: () => Effect.void,
  };
  expect(resolveNodexAccountConfiguration(host).kind).toBe("invalid");
  const fixture = { ...host, environment: { ...host.environment, NODEX_TEST_CLERK_LOOPBACK: "1" } };
  expect(resolveNodexAccountConfiguration(fixture).kind).toBe("ready");
  expect(resolveNodexAccountConfiguration({ ...fixture, isPackaged: true }).kind).toBe("invalid");
});

const fixture = (userinfoFailure = false) =>
  Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-account-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    let issuer = "";
    let revocations = 0;
    let exchangeCount = 0;
    let callbackBody = "";
    let failUserinfo = userinfoFailure;
    let expiresIn = 300;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          response.setHeader("content-type", "application/json");
          if (request.url === "/.well-known/openid-configuration") {
            response.end(
              JSON.stringify({
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                userinfo_endpoint: `${issuer}/userinfo`,
                revocation_endpoint: `${issuer}/revoke`,
              }),
            );
            return;
          }
          if (request.url === "/token") {
            exchangeCount++;
            response.end(
              JSON.stringify({
                access_token:
                  exchangeCount === 1 ? "secret-access" : `secret-access-${exchangeCount}`,
                refresh_token:
                  exchangeCount === 1 ? "secret-refresh" : `secret-refresh-${exchangeCount}`,
                expires_in: expiresIn,
                token_type: "Bearer",
              }),
            );
            return;
          }
          if (request.url === "/userinfo") {
            response.statusCode = failUserinfo ? 503 : 200;
            response.end(
              JSON.stringify(
                failUserinfo
                  ? { error: "unavailable" }
                  : { sub: "alice", email: "alice@example.com" },
              ),
            );
            return;
          }
          if (request.url === "/revoke") {
            revocations++;
            response.end("{}");
            return;
          }
          response.statusCode = 404;
          response.end("{}");
        }),
      ),
      (server) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );
    const port = yield* Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string") resume(Effect.succeed(address.port));
      });
    });
    issuer = `http://127.0.0.1:${port}`;
    const host: NodexAccountHost = {
      home,
      isPackaged: false,
      environment: {
        NODEX_CLERK_ISSUER: issuer,
        NODEX_CLERK_CLIENT_ID: "client",
        NODEX_TEST_CLERK_LOOPBACK: "1",
      },
      openExternal: (url) =>
        Effect.promise(async () => {
          const authorization = new URL(url);
          expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
          expect(authorization.searchParams.get("code_challenge")).toHaveLength(43);
          const callback = new URL(authorization.searchParams.get("redirect_uri")!);
          callback.search = new URLSearchParams({
            state: authorization.searchParams.get("state")!,
            code: "authorization-code",
          }).toString();
          const response = await fetch(callback);
          callbackBody = await response.text();
          expect(response.status).toBe(200);
        }),
    };
    const encryption = {
      isAvailable: () => true,
      encryptString: (text: string) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0xff)),
      decryptString: (bytes: Buffer) =>
        Buffer.from(bytes.map((byte) => byte ^ 0xff)).toString("utf8"),
    };
    const platform = yield* make(host).pipe(Effect.provideService(SecretEncryption, encryption));
    return {
      host,
      platform,
      encryption,
      home,
      revocations: () => revocations,
      exchangeCount: () => exchangeCount,
      callbackBody: () => callbackBody,
      setUserinfoFailure: (value: boolean) => {
        failUserinfo = value;
      },
      setExpiresIn: (value: number) => {
        expiresIn = value;
      },
    };
  });

it.live("flushes the browser response and revokes a grant that cannot establish identity", () =>
  Effect.gen(function* () {
    const value = yield* fixture(true);
    const result = yield* value.platform.login.pipe(Effect.scoped, Effect.result);
    expect(result._tag).toBe("Failure");
    expect(value.callbackBody().length).toBeGreaterThan(0);
    expect(value.exchangeCount()).toBe(1);
    expect(value.revocations()).toBe(1);
  }).pipe(Effect.scoped),
);

it.live(
  "retains only accepted grants and isolates encrypted credentials by Profile and client",
  () =>
    Effect.gen(function* () {
      const value = yield* fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* value.platform.login;
          yield* value.platform.save(lease.credentials);
          yield* lease.retain;
        }),
      );
      expect(value.revocations()).toBe(0);
      const stored = yield* value.platform.load;
      expect(stored?.identity.subject).toBe("alice");
      expect(stored && Redacted.value(stored.accessToken)).toBe("secret-access");
      const ciphertext = yield* Effect.promise(() =>
        readFile(join(value.home, "account/credentials.enc")),
      );
      expect(ciphertext.toString("utf8")).not.toContain("secret-access");
      const changedClient = yield* make({
        ...value.host,
        environment: { ...value.host.environment, NODEX_CLERK_CLIENT_ID: "other-client" },
      }).pipe(Effect.provideService(SecretEncryption, value.encryption));
      expect(yield* changedClient.load).toBeNull();
      yield* value.platform.clear;
      expect(yield* value.platform.load).toBeNull();
    }).pipe(Effect.scoped),
);

it.live("releases a newly issued grant when its caller never adopts it", () =>
  Effect.gen(function* () {
    const value = yield* fixture();
    yield* value.platform.login.pipe(Effect.scoped);
    expect(value.revocations()).toBe(1);
  }).pipe(Effect.scoped),
);

it.live(
  "remembers rotated credentials through a verification outage and recovers after restart",
  () =>
    Effect.gen(function* () {
      const value = yield* fixture();
      value.setExpiresIn(30);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* value.platform.login;
          yield* value.platform.save(lease.credentials);
          yield* lease.retain;
        }),
      );
      value.setExpiresIn(300);
      value.setUserinfoFailure(true);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* makeAccount.pipe(
            Effect.provideService(NodexAccountPlatform, value.platform),
          );
          const unavailable = yield* owner.changes.pipe(
            Stream.filter((state) => state.error === "network"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
          expect(unavailable.status).toBe("signed-in");
          expect(unavailable.account?.subject).toBe("alice");
          expect(unavailable.connection).toBe("unavailable");
          const saved = yield* value.platform.load;
          expect(saved && Redacted.value(saved.refreshToken!)).toBe("secret-refresh-2");
          expect(value.exchangeCount()).toBe(2);
          expect(value.revocations()).toBe(0);
        }),
      );
      value.setUserinfoFailure(false);
      const restarted = yield* makeAccount.pipe(
        Effect.provideService(NodexAccountPlatform, value.platform),
      );
      const recovered = yield* restarted.changes.pipe(
        Stream.filter((state) => state.connection === "available"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(recovered.status).toBe("signed-in");
      expect(recovered.account?.subject).toBe("alice");
      expect(recovered.error).toBeNull();
      expect(value.exchangeCount()).toBe(2);
      expect(value.revocations()).toBe(0);
    }).pipe(Effect.scoped),
);

it.live("revokes an unretained rotated grant when verification is unavailable", () =>
  Effect.gen(function* () {
    const value = yield* fixture();
    value.setExpiresIn(30);
    const original = yield* Effect.scoped(
      value.platform.login.pipe(
        Effect.tap((lease) => lease.retain),
        Effect.map((lease) => lease.credentials),
      ),
    );
    value.setUserinfoFailure(true);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const abandoned = yield* value.platform.refresh(original);
        expect(abandoned.verified).toBe(false);
        expect(abandoned.credentials.identity).toEqual(original.identity);
        expect(
          abandoned.credentials.refreshToken && Redacted.value(abandoned.credentials.refreshToken),
        ).toBe("secret-refresh-2");
      }),
    );
    expect(value.revocations()).toBe(1);
  }).pipe(Effect.scoped),
);
