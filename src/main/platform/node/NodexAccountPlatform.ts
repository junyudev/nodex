/* @effect-diagnostics asyncFunction:off -- HTTP and encrypted filesystem access are Node platform boundaries. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { z } from "zod";
import {
  NodexAccountIdentitySchema,
  type NodexAccountErrorCode,
} from "../../../shared/nodex-account";
import {
  NODEX_ACCOUNT_CALLBACK_CSS,
  NODEX_ACCOUNT_CALLBACK_HTML,
} from "../../../shared/nodex-account-copy";
import {
  NodexAccountPlatform,
  NodexAccountPlatformError,
  type NodexAccountCredentialLease,
  type NodexAccountRefreshLease,
} from "../NodexAccountPlatform";
import { SecretEncryption } from "../SecretEncryption";

const failure = (code: NodexAccountErrorCode) => new NodexAccountPlatformError({ code });
const MAX_RESPONSE_BYTES = 64 * 1024;
const callbackStyleHash = createHash("sha256").update(NODEX_ACCOUNT_CALLBACK_CSS).digest("base64");
const scopes = "openid profile email offline_access";
const tokenSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384).optional(),
  expires_in: z.number().positive().max(31_536_000),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});
const metadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url(),
  revocation_endpoint: z.string().url(),
});
const userSchema = z.object({
  sub: z.string().min(1).max(1024),
  email: z.string().max(1024).nullish(),
  name: z.string().max(1024).nullish(),
  picture: z.string().max(4096).nullish(),
});
const storedSchema = z
  .object({
    version: z.literal(1),
    issuer: z.string(),
    clientId: z.string(),
    profileHome: z.string(),
    identity: NodexAccountIdentitySchema,
    accessToken: z.string().min(1).max(16_384),
    refreshToken: z.string().min(1).max(16_384).nullable(),
    expiresAt: z.number().finite().positive(),
  })
  .strict();

export interface NodexAccountHost {
  readonly home: string;
  readonly isPackaged: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly openExternal: (url: string) => Effect.Effect<void, NodexAccountPlatformError>;
}

/** Unrelated requests never consume the one pending authorization response. */
export const parseNodexAccountCallback = (input: {
  readonly method: string | undefined;
  readonly host: string | undefined;
  readonly url: string | undefined;
  readonly redirectUri: string;
  readonly state: string;
}):
  | { readonly kind: "invalid" }
  | { readonly kind: "denied" }
  | { readonly kind: "code"; readonly code: string } => {
  if (input.method !== "GET" || !input.url || input.url.length > 8192) return { kind: "invalid" };
  try {
    const expected = new URL(input.redirectUri);
    const url = new URL(input.url, expected);
    const actualState = Buffer.from(url.searchParams.get("state") ?? "");
    const expectedState = Buffer.from(input.state);
    if (
      input.host !== expected.host ||
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll("state").length !== 1 ||
      actualState.length !== expectedState.length ||
      !timingSafeEqual(actualState, expectedState)
    )
      return { kind: "invalid" };
    if (url.searchParams.has("error"))
      return { kind: url.searchParams.has("code") ? "invalid" : "denied" };
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096 || url.searchParams.getAll("code").length !== 1)
      return { kind: "invalid" };
    return { kind: "code", code };
  } catch {
    return { kind: "invalid" };
  }
};

/** Only the public issuer/client ID are configurable; credentials never come from environment. */
export const resolveNodexAccountConfiguration = (host: NodexAccountHost) => {
  const issuer = host.environment.NODEX_CLERK_ISSUER?.trim();
  const clientId = host.environment.NODEX_CLERK_CLIENT_ID?.trim();
  if (!issuer && !clientId) return { kind: "absent" } as const;
  if (!issuer || !clientId || clientId.length > 1024) return { kind: "invalid" } as const;
  try {
    const url = new URL(issuer);
    const fixture = !host.isPackaged && host.environment.NODEX_TEST_CLERK_LOOPBACK === "1";
    if (
      (url.protocol !== "https:" &&
        !(fixture && url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return { kind: "invalid" } as const;
    return { kind: "ready", issuer: url.origin, clientId } as const;
  } catch {
    return { kind: "invalid" } as const;
  }
};

/** Bounded responses, same-origin endpoints and no redirects keep credentials at the configured issuer. */
const request = (url: string, init: RequestInit = {}) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal, redirect: "error" });
      const reader = response.body?.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw failure("oauth-invalid-response");
            parts.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      const text = Buffer.concat(parts).toString("utf8");
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (response.ok) return parsed;
      const oauthError = z.object({ error: z.string() }).safeParse(parsed);
      if (
        response.status === 401 ||
        (oauthError.success && oauthError.data.error === "invalid_grant")
      )
        throw failure("invalid-grant");
      throw failure(
        response.status >= 500 || response.status === 429 ? "network" : "oauth-invalid-response",
      );
    },
    catch: (cause) => (cause instanceof NodexAccountPlatformError ? cause : failure("network")),
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchTag("TimeoutError", () => failure("network")),
  );

export const make = Effect.fn("NodexAccountPlatform.make")(function* (host: NodexAccountHost) {
  const encryption = yield* SecretEncryption;
  const configuration = resolveNodexAccountConfiguration(host);
  const directory = join(host.home, "account");
  const path = join(directory, "credentials.enc");
  const configured = configuration.kind === "ready";
  const checkConfiguration = Effect.suspend(() =>
    configuration.kind === "ready" ? Effect.succeed(configuration) : failure("not-configured"),
  );
  const metadata = Effect.gen(function* () {
    const config = yield* checkConfiguration;
    const raw = yield* request(`${config.issuer}/.well-known/openid-configuration`);
    const parsed = metadataSchema.safeParse(raw);
    if (!parsed.success || parsed.data.issuer.replace(/\/$/u, "") !== config.issuer)
      return yield* failure("oauth-invalid-response");
    for (const endpoint of [
      parsed.data.authorization_endpoint,
      parsed.data.token_endpoint,
      parsed.data.userinfo_endpoint,
      parsed.data.revocation_endpoint,
    ]) {
      const url = new URL(endpoint);
      if (url.origin !== config.issuer || url.username || url.password || url.hash)
        return yield* failure("oauth-invalid-response");
    }
    return parsed.data;
  });
  const token = (endpoint: string, values: Record<string, string>) =>
    request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString(),
    }).pipe(
      Effect.flatMap((raw) => {
        const parsed = tokenSchema.safeParse(raw);
        return parsed.success ? Effect.succeed(parsed.data) : failure("oauth-invalid-response");
      }),
    );
  const identity = (endpoint: string, accessToken: Redacted.Redacted) =>
    Effect.gen(function* () {
      const config = yield* checkConfiguration;
      const raw = yield* request(endpoint, {
        headers: { authorization: `Bearer ${Redacted.value(accessToken)}` },
      });
      const parsed = userSchema.safeParse(raw);
      if (!parsed.success) return yield* failure("oauth-invalid-response");
      const picture = parsed.data.picture;
      return {
        issuer: config.issuer,
        subject: parsed.data.sub,
        email: parsed.data.email ?? null,
        name: parsed.data.name ?? null,
        imageUrl: picture?.startsWith("https://") ? picture : null,
      };
    });
  const revokeToken = (
    endpoint: string,
    tokenValue: string,
    hint: "refresh_token" | "access_token",
  ) =>
    Effect.gen(function* () {
      const config = yield* checkConfiguration;
      yield* request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokenValue,
          client_id: config.clientId,
          token_type_hint: hint,
        }).toString(),
      });
    });
  const acquireTokens = (
    endpoints: z.infer<typeof metadataSchema>,
    values: Record<string, string>,
  ) =>
    Effect.gen(function* () {
      const retained = yield* Ref.make(false);
      const tokens = yield* Effect.acquireRelease(
        token(endpoints.token_endpoint, values),
        (tokens) =>
          Ref.get(retained).pipe(
            Effect.flatMap((keep) =>
              keep
                ? Effect.void
                : revokeToken(
                    endpoints.revocation_endpoint,
                    tokens.refresh_token ?? tokens.access_token,
                    tokens.refresh_token ? "refresh_token" : "access_token",
                  ).pipe(Effect.ignore),
            ),
          ),
      );
      const receivedAt = yield* Clock.currentTimeMillis;
      return { tokens, receivedAt, retain: Ref.set(retained, true) };
    });
  const requirePrivateDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw failure("secure-storage");
    await chmod(directory, 0o700);
  };
  const clearCredentialFile = async () => {
    try {
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw failure("secure-storage");
      await rm(path, { force: true });
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return;
      throw cause;
    }
  };
  const clear = Effect.tryPromise({
    try: clearCredentialFile,
    catch: () => failure("secure-storage"),
  });

  return NodexAccountPlatform.of({
    configured,
    configurationError: configuration.kind === "invalid",
    clear,
    load: Effect.tryPromise({
      try: async () => {
        if (configuration.kind !== "ready") return null;
        let file;
        try {
          const info = await lstat(directory);
          if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            (process.getuid && info.uid !== process.getuid())
          )
            throw failure("secure-storage");
          file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (cause) {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
            return null;
          throw cause;
        }
        try {
          const info = await file.stat();
          if (
            !info.isFile() ||
            info.size > MAX_RESPONSE_BYTES ||
            (info.mode & 0o077) !== 0 ||
            (process.getuid && info.uid !== process.getuid()) ||
            !encryption.isAvailable()
          )
            throw failure("secure-storage");
          const stored = storedSchema.parse(
            JSON.parse(encryption.decryptString(await file.readFile())),
          );
          if (
            stored.issuer !== configuration.issuer ||
            stored.clientId !== configuration.clientId ||
            stored.profileHome !== resolve(host.home) ||
            stored.identity.issuer !== configuration.issuer
          )
            return null;
          return {
            identity: stored.identity,
            accessToken: Redacted.make(stored.accessToken),
            refreshToken: stored.refreshToken ? Redacted.make(stored.refreshToken) : null,
            expiresAt: stored.expiresAt,
          };
        } finally {
          await file.close();
        }
      },
      catch: () => failure("secure-storage"),
    }),
    save: (credentials) =>
      Effect.tryPromise({
        try: async () => {
          if (configuration.kind !== "ready") throw failure("not-configured");
          if (!encryption.isAvailable()) {
            await clearCredentialFile();
            return "memory" as const;
          }
          const payload = {
            version: 1,
            issuer: configuration.issuer,
            clientId: configuration.clientId,
            profileHome: resolve(host.home),
            identity: credentials.identity,
            accessToken: Redacted.value(credentials.accessToken),
            refreshToken: credentials.refreshToken
              ? Redacted.value(credentials.refreshToken)
              : null,
            expiresAt: credentials.expiresAt,
          };
          const ciphertext = encryption.encryptString(JSON.stringify(payload));
          await requirePrivateDirectory();
          const temporary = join(directory, `${randomBytes(16).toString("hex")}.tmp`);
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(ciphertext);
            await file.sync();
            await file.close();
            await rename(temporary, path);
          } finally {
            await file.close();
            await rm(temporary, { force: true });
          }
          return "secure" as const;
        },
        catch: () => failure("secure-storage"),
      }),
    login: Effect.gen(function* () {
      const config = yield* checkConfiguration;
      const endpoints = yield* metadata;
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const received = yield* Deferred.make<string, NodexAccountPlatformError>();
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => createServer({ maxHeaderSize: 8192 })),
        (server) =>
          Effect.sync(() => {
            server.closeAllConnections();
            server.close();
          }),
      );
      server.maxHeadersCount = 32;
      server.headersTimeout = 5000;
      server.requestTimeout = 5000;
      const port = yield* Effect.callback<number, NodexAccountPlatformError>((resume) => {
        server.once("error", () => resume(failure("network")));
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resume(
            address && typeof address !== "string"
              ? Effect.succeed(address.port)
              : failure("network"),
          );
        });
      });
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      let callbackConsumed = false;
      server.on("request", (req, res) => {
        const respond = (status: number, html: string, done?: () => void) => {
          res.writeHead(status, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": `default-src 'none'; style-src 'sha256-${callbackStyleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            connection: "close",
          });
          res.end(html, done);
        };
        if (callbackConsumed) return respond(409, NODEX_ACCOUNT_CALLBACK_HTML.invalid);
        const callback = parseNodexAccountCallback({
          method: req.method,
          host: req.headers.host,
          url: req.url,
          redirectUri,
          state,
        });
        if (callback.kind === "invalid") return respond(400, NODEX_ACCOUNT_CALLBACK_HTML.invalid);
        callbackConsumed = true;
        if (callback.kind === "denied")
          return respond(400, NODEX_ACCOUNT_CALLBACK_HTML.denied, () => {
            Deferred.doneUnsafe(received, failure("oauth-denied"));
          });
        return respond(200, NODEX_ACCOUNT_CALLBACK_HTML.success, () => {
          Deferred.doneUnsafe(received, Effect.succeed(callback.code));
        });
      });
      const authorization = new URL(endpoints.authorization_endpoint);
      authorization.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: scopes,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      yield* host.openExternal(authorization.href);
      const code = yield* Deferred.await(received).pipe(
        Effect.timeout("5 minutes"),
        Effect.catchTag("TimeoutError", () => failure("oauth-timeout")),
      );
      const grant = yield* acquireTokens(endpoints, {
        grant_type: "authorization_code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      });
      const tokens = grant.tokens;
      const accessToken = Redacted.make(tokens.access_token);
      const account = yield* identity(endpoints.userinfo_endpoint, accessToken);
      return {
        credentials: {
          identity: account,
          accessToken,
          refreshToken: tokens.refresh_token ? Redacted.make(tokens.refresh_token) : null,
          expiresAt: grant.receivedAt + tokens.expires_in * 1000,
        },
        retain: grant.retain,
      } satisfies NodexAccountCredentialLease;
    }),
    refresh: (previous) =>
      Effect.gen(function* () {
        const config = yield* checkConfiguration;
        const endpoints = yield* metadata;
        const now = yield* Clock.currentTimeMillis;
        let next = previous;
        let retain = Effect.void;
        let rotated = false;
        if (previous.expiresAt - now <= 60_000) {
          if (!previous.refreshToken) return yield* failure("invalid-grant");
          const grant = yield* acquireTokens(endpoints, {
            grant_type: "refresh_token",
            client_id: config.clientId,
            refresh_token: Redacted.value(previous.refreshToken),
          });
          const tokens = grant.tokens;
          retain = grant.retain;
          rotated = true;
          next = {
            ...previous,
            accessToken: Redacted.make(tokens.access_token),
            refreshToken: tokens.refresh_token
              ? Redacted.make(tokens.refresh_token)
              : previous.refreshToken,
            expiresAt: grant.receivedAt + tokens.expires_in * 1000,
          };
        }
        const verification = yield* identity(endpoints.userinfo_endpoint, next.accessToken).pipe(
          Effect.result,
        );
        if (verification._tag === "Failure") {
          if (rotated && verification.failure.code === "network")
            return {
              credentials: next,
              retain,
              verified: false,
            } satisfies NodexAccountRefreshLease;
          return yield* rotated ? failure("invalid-grant") : verification.failure;
        }
        const account = verification.success;
        if (
          account.issuer !== previous.identity.issuer ||
          account.subject !== previous.identity.subject
        )
          return yield* failure("identity-changed");
        return {
          credentials: { ...next, identity: account },
          retain,
          verified: true,
        } satisfies NodexAccountRefreshLease;
      }),
    revoke: (credentials) =>
      Effect.gen(function* () {
        const endpoints = yield* metadata;
        yield* revokeToken(
          endpoints.revocation_endpoint,
          Redacted.value(credentials.refreshToken ?? credentials.accessToken),
          credentials.refreshToken ? "refresh_token" : "access_token",
        );
      }).pipe(Effect.mapError(() => failure("revocation-failed"))),
  });
});
