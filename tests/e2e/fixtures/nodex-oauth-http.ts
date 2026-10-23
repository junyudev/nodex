import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const CLIENT_ID = "nodex-electron-scenario";
const IDENTITY = {
  sub: "nodex-account-scenario",
  email: "account@nodex.invalid",
  name: "Nodex Scenario",
};

interface Grant {
  revoked: boolean;
}

interface AuthorizationCode {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly grant: Grant;
}

export interface NodexOAuthEvidence {
  readonly authorizations: number;
  readonly verifiedCodeExchanges: number;
  readonly refreshes: number;
  readonly revocations: number;
  readonly invalidRequests: readonly string[];
}

export interface NodexOAuthHttpFixture {
  readonly environment: Readonly<Record<string, string>>;
  readonly email: string;
  readonly subject: string;
  readonly evidence: () => NodexOAuthEvidence;
  readonly authorize: (authorizationUrl: string) => Promise<URL>;
  readonly revokeGrants: () => void;
  readonly setAvailable: (available: boolean) => void;
  readonly close: () => Promise<void>;
}

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

const readForm = async (request: IncomingMessage): Promise<URLSearchParams> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
};

/** A real loopback OAuth peer: Main still owns discovery, PKCE, callbacks and encrypted storage. */
export async function startNodexOAuthHttpFixture(): Promise<NodexOAuthHttpFixture> {
  const codes = new Map<string, AuthorizationCode>();
  const accessTokens = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const grants = new Set<Grant>();
  const invalidRequests: string[] = [];
  let issuer = "";
  let available = true;
  let authorizations = 0;
  let verifiedCodeExchanges = 0;
  let refreshes = 0;
  let revocations = 0;

  const invalid = (response: ServerResponse, reason: string): void => {
    invalidRequests.push(reason);
    sendJson(response, 400, { error: "invalid_request" });
  };
  const issue = (response: ServerResponse, grant: Grant, expiresIn: number): void => {
    const accessToken = `scenario-access-${randomUUID()}`;
    const refreshToken = `scenario-refresh-${randomUUID()}`;
    accessTokens.set(accessToken, grant);
    refreshTokens.set(refreshToken, grant);
    sendJson(response, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: "openid profile email offline_access",
    });
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!available) return sendJson(response, 503, { error: "temporarily_unavailable" });
    const url = new URL(request.url ?? "/", issuer);
    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return sendJson(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      const params = url.searchParams;
      const redirectUri = params.get("redirect_uri") ?? "";
      const redirect = URL.canParse(redirectUri) ? new URL(redirectUri) : null;
      const challenge = params.get("code_challenge") ?? "";
      const expectedScopes = ["email", "offline_access", "openid", "profile"];
      const scopes = (params.get("scope") ?? "").split(" ").sort();
      if (
        params.get("client_id") !== CLIENT_ID ||
        params.get("response_type") !== "code" ||
        params.get("code_challenge_method") !== "S256" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(challenge) ||
        !params.get("state") ||
        !redirect ||
        redirect.protocol !== "http:" ||
        redirect.hostname !== "127.0.0.1" ||
        !redirect.port ||
        redirect.pathname !== "/callback" ||
        JSON.stringify(scopes) !== JSON.stringify(expectedScopes)
      )
        return invalid(
          response,
          "Authorization must bind the public client, loopback, state and S256",
        );
      const grant = { revoked: false };
      grants.add(grant);
      const code = randomUUID();
      codes.set(code, { challenge, redirectUri, grant });
      authorizations += 1;
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", params.get("state")!);
      response.writeHead(302, { location: redirect.href, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const form = await readForm(request);
      if (form.get("client_id") !== CLIENT_ID) return invalid(response, "Token client mismatch");
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code") ?? "";
        const authorization = codes.get(code);
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          !authorization ||
          authorization.grant.revoked ||
          verifier.length < 43 ||
          challenge !== authorization.challenge ||
          form.get("redirect_uri") !== authorization.redirectUri
        )
          return invalid(
            response,
            "Code exchange must prove its original PKCE verifier and redirect",
          );
        codes.delete(code);
        verifiedCodeExchanges += 1;
        return issue(response, authorization.grant, 45);
      }
      if (form.get("grant_type") === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        const grant = refreshTokens.get(token);
        if (!grant || grant.revoked) return sendJson(response, 400, { error: "invalid_grant" });
        refreshTokens.delete(token);
        refreshes += 1;
        return issue(response, grant, 3_600);
      }
      return invalid(response, "Unsupported token grant");
    }
    if (request.method === "GET" && url.pathname === "/userinfo") {
      const token = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
      const grant = accessTokens.get(token);
      if (!grant || grant.revoked) return sendJson(response, 401, { error: "invalid_token" });
      return sendJson(response, 200, IDENTITY);
    }
    if (request.method === "POST" && url.pathname === "/revoke") {
      const form = await readForm(request);
      if (form.get("client_id") !== CLIENT_ID)
        return invalid(response, "Revocation client mismatch");
      const token = form.get("token") ?? "";
      const grant = accessTokens.get(token) ?? refreshTokens.get(token);
      if (!grant) return invalid(response, "Revocation must name an issued token");
      grant.revoked = true;
      revocations += 1;
      return sendJson(response, 200, {});
    }
    return invalid(response, `Unexpected OAuth route: ${request.method} ${url.pathname}`);
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      invalidRequests.push("OAuth fixture failed while handling a request");
      if (!response.headersSent) sendJson(response, 500, { error: "server_error" });
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("OAuth fixture has no loopback port");
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    environment: {
      NODEX_CLERK_ISSUER: issuer,
      NODEX_CLERK_CLIENT_ID: CLIENT_ID,
      NODEX_TEST_CLERK_LOOPBACK: "1",
    },
    email: IDENTITY.email,
    subject: IDENTITY.sub,
    evidence: () => ({
      authorizations,
      verifiedCodeExchanges,
      refreshes,
      revocations,
      invalidRequests: [...invalidRequests],
    }),
    authorize: async (authorizationUrl) => {
      if (new URL(authorizationUrl).origin !== issuer)
        throw new Error("Unexpected authorization origin");
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status !== 302 || !location) throw new Error("OAuth authorization was rejected");
      return new URL(location);
    },
    revokeGrants: () => {
      for (const grant of grants) grant.revoked = true;
    },
    setAvailable: (next) => {
      available = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
