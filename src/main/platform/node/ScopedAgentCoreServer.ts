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
import { CoreClient } from "../../core-client/core-client";
import { readCoreRuntimeConnection } from "../../core-client/runtime-descriptor";
import { ScopedAgentCore } from "../../../host/ScopedAgentCore";

const MAX_GRANTS = 256;
const MAX_REQUESTS = 16;
const GRANT_AGE_MS = 24 * 60 * 60 * 1000;

const admittedRoute = (method: string | undefined, path: string): boolean => {
  if (method === "GET") return /^\/core\/v1\/files\/blobs\/[A-Za-z0-9_-]+$/u.test(path);
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

async function collect(stream: IncomingMessage, maximum: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of stream) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > maximum) throw new Error("Agent content exceeds its byte bound");
    parts.push(bytes);
  }
  return Buffer.concat(parts, size);
}

const reply = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

interface Grant {
  readonly owner: string;
  readonly createdAt: number;
  readonly authorize: () => Promise<boolean>;
  readonly runtime: ReturnType<typeof readCoreRuntimeConnection>;
  readonly client: CoreClient;
  readonly connectionId: string;
  readonly projectId: string | null;
  readonly attribution: string;
}

/** A loopback content audience, never a second Core or a general Host invocation tunnel. */
export async function openScopedAgentCore(coreHome: string) {
  const grants = new Map<string, Grant>();
  let active = 0;
  let open = true;
  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const token = request.headers.authorization?.replace(/^Bearer /u, "");
    const grant = token ? grants.get(token) : undefined;
    if (
      !open ||
      !grant ||
      Date.now() - grant.createdAt > GRANT_AGE_MS ||
      !(await grant.authorize())
    ) {
      reply(response, 401, { error: "Agent Turn authority is unavailable" });
      return;
    }
    const current = readCoreRuntimeConnection(coreHome);
    if (current.descriptor.start_nonce !== grant.runtime.descriptor.start_nonce) {
      reply(response, 401, { error: "Agent Turn belongs to a retired Core generation" });
      return;
    }
    if (request.method === "GET" && request.url === "/agent/context") {
      // No private socket or filesystem location crosses this audience.
      reply(response, 200, {
        descriptor: { ...grant.runtime.descriptor, endpoint: "scoped-agent-content" },
        handshake: grant.client.handshake,
      });
      return;
    }
    const path = request.url?.split("?", 1)[0] ?? "";
    if (!admittedRoute(request.method, path)) {
      reply(response, 403, { error: "This operation requires the Host" });
      return;
    }
    if (active >= MAX_REQUESTS) {
      reply(response, 429, { error: "Agent content capacity is exhausted" });
      return;
    }
    active++;
    try {
      const body = await collect(request, byteLimit(path));
      if (!(await grant.authorize())) {
        reply(response, 401, { error: "Agent Turn authority is unavailable" });
        return;
      }
      const forwarded = await new Promise<{
        status: number;
        bytes: Buffer;
        contentType?: string;
        etag?: string;
      }>((resolve, reject) => {
        const upstream = coreRequest(
          {
            socketPath: grant.runtime.descriptor.endpoint,
            method: request.method,
            path: request.url,
            agent: false,
            headers: {
              authorization: `Bearer ${grant.runtime.authCapability}`,
              "x-nodex-connection-id": grant.connectionId,
              "x-nodex-connection-binding": grant.client.handshake.connection_binding,
              "x-nodex-agent-attribution": grant.attribution,
              ...(grant.projectId ? { "x-nodex-project-id": grant.projectId } : {}),
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
      void serve(request, response).catch(() => {
        if (!response.headersSent) reply(response, 502, { error: "Agent content is unavailable" });
        else response.destroy();
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
    issue: async (input: {
      owner: string;
      projectId: string | null;
      attribution: string;
      authorize: () => Promise<boolean>;
    }) => {
      if (!open || !input.attribution || !(await input.authorize()))
        throw new Error("Agent Turn authority is unavailable");
      for (const [key, old] of grants) {
        if (old.owner === input.owner || Date.now() - old.createdAt > GRANT_AGE_MS)
          grants.delete(key);
      }
      if (grants.size >= MAX_GRANTS) throw new Error("Agent Turn credential capacity is exhausted");
      const runtime = readCoreRuntimeConnection(coreHome);
      const connectionId = `agent-cli:${randomUUID()}`;
      const client = await CoreClient.connect({
        nodexHome: coreHome,
        clientKind: "native_cli",
        buildId: "nodex-agent-content",
        connectionId,
      });
      const credential = randomBytes(32).toString("base64url");
      grants.set(credential, { ...input, runtime, client, connectionId, createdAt: Date.now() });
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
        Effect.tryPromise(() => openScopedAgentCore(coreHome)),
        (server) => Effect.promise(server.close),
      );
      return {
        issue: (input) =>
          Effect.tryPromise(() =>
            server.issue({ ...input, authorize: () => run(input.authorize).catch(() => false) }),
          ),
      };
    }),
  );
