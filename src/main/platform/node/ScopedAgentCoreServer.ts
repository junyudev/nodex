/* @effect-diagnostics asyncFunction:off newPromise:off preferSchemaOverJson:off -- Bounded HTTP and process-lifetime admission are Node Adapter work. */
import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  request as coreRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import { CORE_TRANSPORT_BUDGETS } from "@nodex/core-protocol";
import type { AgentAttributionRequest } from "../../core-client/types";
import type { CoreAuthorityIdentity } from "../../core-runtime/CoreAuthority";
import { CoreHttpError } from "../../core-client/local-http";
import { CoreClient } from "../../core-client/core-client";
import { readCoreRuntimeConnection } from "../../core-client/runtime-descriptor";
import { MainApplicationError } from "../../app/MainApplication";
import { MainConfig } from "../../app/MainConfig";
import { ScopedAgentCore, type ScopedAgentAdmission } from "../../../host/ScopedAgentCore";

const MAX_GRANTS = 256;
const MAX_REQUESTS = 16;
// Renew the internal Core credential well before Core retires it. Shell grants
// have the lifetime of their verified execution.
const CORE_CREDENTIAL_REFRESH_MS = 60 * 60 * 1000;

const admittedRoute = (method: string | undefined, path: string): boolean => {
  if (method === "GET")
    return path === "/core/v1/identity" || /^\/core\/v1\/files\/blobs\/[A-Za-z0-9_-]+$/u.test(path);
  if (method !== "POST") return false;
  return (
    /^\/core\/v1\/modules\/(?:library|database|workspace|automation|document)\/(?:read|apply)$/u.test(
      path,
    ) ||
    path === "/core/v1/modules/query/read" ||
    path === "/core/v1/modules/workspace/tool-operations/admit" ||
    path === "/core/v1/files/blobs/prepare"
  );
};

const byteLimit = (path: string, response = false): number => {
  if (path.startsWith("/core/v1/files/blobs/")) return CORE_TRANSPORT_BUDGETS.file_blob_bytes;
  if (path.startsWith("/core/v1/modules/document/"))
    return response
      ? CORE_TRANSPORT_BUDGETS.document_response_bytes
      : CORE_TRANSPORT_BUDGETS.document_json_request_bytes;
  return response
    ? CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes
    : CORE_TRANSPORT_BUDGETS.ordinary_json_request_bytes;
};

class AgentContentBudgetExceeded extends Error {}

async function collect(stream: IncomingMessage, maximum: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of stream) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > maximum)
      throw new AgentContentBudgetExceeded("Agent content exceeds its byte bound");
    parts.push(bytes);
  }
  return Buffer.concat(parts, size);
}

const reply = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

type CoreError = NonNullable<CoreHttpError["coreError"]>;

const refuse = (
  response: ServerResponse,
  status: number,
  code: CoreError["code"],
  message: string,
): void =>
  reply(response, status, {
    status: "error",
    payload: { code, message, retryable: false, recovery: { kind: "none" } },
  });

const turnEnded = (response: ServerResponse) =>
  refuse(
    response,
    401,
    "agent_turn_ended",
    "This Agent Turn has ended. Run nodex from an active Turn to preserve Agent authorship.",
  );

const generationChanged = (response: ServerResponse) =>
  refuse(
    response,
    409,
    "agent_generation_changed",
    "The Agent Host or Core generation changed. Run nodex context again from the active Turn.",
  );

interface GrantInput {
  readonly owner: string;
  readonly authorize: () => Promise<ScopedAgentAdmission>;
  readonly identity: CoreAuthorityIdentity;
  readonly projectId: string | null;
  readonly attribution: AgentAttributionRequest;
}

interface Grant extends GrantInput {
  core?: {
    readonly nonce: string;
    readonly issuedAt: number;
    readonly ready: Promise<{
      readonly client: CoreClient;
      readonly credential: string;
    } | null>;
  };
}

/** A loopback content audience, never a second Core or a general Host invocation tunnel. */
export async function openScopedAgentCore(coreHome: string) {
  const generation = randomBytes(12).toString("base64url");
  const grants = new Map<string, Grant>();
  let active = 0;
  let open = true;

  // Both registrations belong to this gateway process. Core can reclaim either
  // after idle time, so re-handshake with the same IDs instead of consuming slots.
  const hostConnectionId = `agent-gateway-host:${randomUUID()}`;
  const connectionId = `agent-gateway-cli:${randomUUID()}`;
  let hostConnection: { nonce: string; client: Promise<CoreClient> } | undefined;
  const hostFor = (nonce: string) => {
    if (hostConnection?.nonce !== nonce) {
      hostConnection = {
        nonce,
        client: CoreClient.connect({
          nodexHome: coreHome,
          clientKind: "electron_host",
          buildId: "nodex-agent-content",
          connectionId: hostConnectionId,
        }),
      };
    }
    return hostConnection;
  };
  const matches = (client: CoreClient, grant: Grant, nonce: string) =>
    client.handshake.generation.start_nonce === nonce &&
    client.handshake.generation.profile_id === grant.identity.profileId &&
    client.handshake.library_id === grant.identity.libraryId &&
    client.handshake.store_epoch === grant.identity.storeEpoch;
  const issue = async (grant: Grant, nonce: string, retry = true): Promise<string> => {
    const pending = hostFor(nonce);
    const host = await pending.client.catch((error: unknown) => {
      if (hostConnection === pending) hostConnection = undefined;
      throw error;
    });
    if (!matches(host, grant, nonce)) return "";
    try {
      return await host.issueAgentAttribution(grant.attribution);
    } catch (error) {
      if (
        !retry ||
        !(error instanceof CoreHttpError) ||
        error.status !== 401 ||
        error.message !== "connection has not completed a compatible Core handshake"
      )
        throw error;
      if (hostConnection === pending) hostConnection = undefined;
      return issue(grant, nonce, false);
    }
  };
  const connect = async (grant: Grant, nonce: string) => {
    const credential = await issue(grant, nonce);
    if (!credential) return null;
    const client = await CoreClient.connect({
      nodexHome: coreHome,
      clientKind: "native_cli",
      buildId: "nodex-agent-content",
      connectionId,
    });
    return matches(client, grant, nonce) ? { client, credential } : null;
  };

  const authorize = async (token: string, grant: Grant, response: ServerResponse) => {
    const result = await grant.authorize();
    if (grants.get(token) !== grant || result === "turn_ended") {
      turnEnded(response);
      return false;
    }
    if (result === "session_unavailable") {
      refuse(
        response,
        404,
        "agent_session_unavailable",
        "The Agent Session is archived, missing, or no longer has an eligible Member. Reopen the Session in Nodex or start a new one.",
      );
      return false;
    }
    return true;
  };

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const token = /^Bearer ([A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43})$/u.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token) {
      refuse(
        response,
        401,
        "agent_binding_malformed",
        "The Agent CLI binding is malformed. Use plain nodex from the active Turn.",
      );
      return;
    }
    if (!token.startsWith(`${generation}.`)) {
      generationChanged(response);
      return;
    }
    const grant = grants.get(token);
    if (!open || !grant) {
      turnEnded(response);
      return;
    }
    const current = readCoreRuntimeConnection(coreHome);
    const nonce = current.descriptor.start_nonce;
    const bootstrap = request.method === "GET" && request.url === "/agent/context";
    if (!bootstrap && request.headers["x-nodex-agent-core-generation"] !== nonce) {
      generationChanged(response);
      return;
    }
    const path = request.url?.split("?", 1)[0] ?? "";
    if (!bootstrap && !admittedRoute(request.method, path)) {
      refuse(response, 403, "unauthorized", "This operation requires the Host.");
      return;
    }
    if (active >= MAX_REQUESTS) {
      refuse(
        response,
        429,
        "resource_exhausted",
        "Agent content capacity is exhausted. Retry after pending commands finish.",
      );
      return;
    }
    active++;
    try {
      if (!(await authorize(token, grant, response))) return;
      if (
        grant.core?.nonce !== nonce ||
        Date.now() - grant.core.issuedAt >= CORE_CREDENTIAL_REFRESH_MS
      )
        grant.core = { nonce, issuedAt: Date.now(), ready: connect(grant, nonce) };
      const pending = grant.core;
      const access = await pending.ready.catch((error: unknown) => {
        if (grant.core === pending) delete grant.core;
        throw error;
      });
      if (!access || readCoreRuntimeConnection(coreHome).descriptor.start_nonce !== nonce) {
        generationChanged(response);
        return;
      }
      const { client, credential } = access;
      if (bootstrap) {
        if (!(await authorize(token, grant, response))) return;
        // No private socket or Core credential crosses this audience.
        reply(response, 200, {
          descriptor: { ...current.descriptor, endpoint: "scoped-agent-content" },
          handshake: { ...client.handshake, connection_binding: "scoped-agent-content" },
          project_id: grant.projectId,
        });
        return;
      }
      const body = await collect(request, byteLimit(path));
      if (!(await authorize(token, grant, response))) return;
      if (readCoreRuntimeConnection(coreHome).descriptor.start_nonce !== nonce) {
        generationChanged(response);
        return;
      }
      if (response.destroyed) return;
      const projectId = request.headers["x-nodex-project-id"];
      const forwarded = await new Promise<{
        status: number;
        bytes: Buffer;
        contentType?: string;
        etag?: string;
      }>((resolve, reject) => {
        const upstream = coreRequest(
          {
            socketPath: current.descriptor.endpoint,
            method: request.method,
            path: request.url,
            agent: false,
            headers: {
              authorization: `Bearer ${current.authCapability}`,
              "x-nodex-connection-id": connectionId,
              "x-nodex-connection-binding": client.handshake.connection_binding,
              "x-nodex-agent-attribution": credential,
              ...(typeof projectId === "string" ? { "x-nodex-project-id": projectId } : {}),
              "x-nodex-request-id": randomUUID(),
              "x-nodex-request-class": "interactive",
              "x-nodex-request-deadline-ms": String(
                CORE_TRANSPORT_BUDGETS.interactive_request_deadline_ms,
              ),
              "content-type": request.headers["content-type"] ?? "application/json",
              "content-length": body.byteLength,
              accept: request.headers.accept ?? "application/json",
            },
          },
          (incoming) => {
            void collect(incoming, byteLimit(path, true)).then(
              (bytes) =>
                resolve({
                  status: incoming.statusCode ?? 502,
                  bytes,
                  contentType: incoming.headers["content-type"],
                  etag: incoming.headers.etag,
                }),
              reject,
            );
          },
        );
        const abort = () => upstream.destroy();
        response.once("close", abort);
        upstream.once("close", () => response.off("close", abort));
        upstream.once("error", reject);
        upstream.setTimeout(30_000, () =>
          upstream.destroy(new Error("Agent content deadline exceeded")),
        );
        upstream.end(body);
      });
      response.writeHead(forwarded.status, {
        "content-type": forwarded.contentType ?? "application/json",
        "cache-control": "no-store",
        ...(forwarded.etag ? { etag: forwarded.etag } : {}),
      });
      response.end(forwarded.bytes);
    } finally {
      active--;
    }
  };
  const server = createServer(
    { requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 },
    (request, response) => {
      void serve(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        if (error instanceof AgentContentBudgetExceeded) {
          refuse(
            response,
            413,
            "resource_exhausted",
            "Agent content exceeded its byte limit. Reduce the payload or requested result.",
          );
          return;
        }
        if (error instanceof CoreHttpError && error.coreError) {
          reply(response, error.status, { status: "error", payload: error.coreError });
          return;
        }
        refuse(
          response,
          502,
          "core_unavailable",
          "Core is unreachable from the Agent Host. Run nodex context again after Core reconnects.",
        );
      });
    },
  );
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Agent content listener is unavailable");
  const endpoint = `http://127.0.0.1:${address.port}`;
  return {
    issue: async (input: GrantInput) => {
      if (!open) throw new Error("Agent content listener is unavailable");
      for (const [key, old] of grants) {
        if (old.owner === input.owner) grants.delete(key);
      }
      if (grants.size >= MAX_GRANTS) {
        await Promise.all(
          [...grants].map(async ([key, old]) => {
            if ((await old.authorize()) !== "allowed") grants.delete(key);
          }),
        );
      }
      if (grants.size >= MAX_GRANTS) throw new Error("Agent Turn credential capacity is exhausted");
      const credential = `${generation}.${randomBytes(32).toString("base64url")}`;
      grants.set(credential, { ...input });
      return { endpoint, credential };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        open = false;
        grants.clear();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export const layer = (coreHome: string) =>
  Layer.effect(
    ScopedAgentCore,
    Effect.gen(function* () {
      const run = yield* FiberSet.makeRuntimePromise();
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => openScopedAgentCore(coreHome),
          catch: (cause) =>
            new MainApplicationError({ phase: "startup", operation: "agent-cli-gateway", cause }),
        }),
        (server) => Effect.promise(server.close),
      );
      return {
        issue: (input) =>
          Effect.tryPromise(() =>
            server.issue({ ...input, authorize: () => run(input.authorize) }),
          ),
      };
    }),
  );

/** The Desktop Profile and headless Host own the same loopback content adapter. */
export const desktopLayer = Layer.unwrap(
  Effect.map(MainConfig, (config) => layer(config.nodexHome)),
);
