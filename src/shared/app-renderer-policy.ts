import { APP_FILESYSTEM_ORIGIN } from "./app-protocol";

export {
  APP_PROTOCOL_SCHEME as APP_RENDERER_PROTOCOL_SCHEME,
  APP_RENDERER_HOST,
  APP_RENDERER_ORIGIN,
  APP_RENDERER_URL,
} from "./app-protocol";
export const VITE_REACT_REFRESH_PREAMBLE_SHA256 =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

const DEVELOPMENT_RENDERER_CONNECTION_FALLBACKS = [
  "http://localhost:*",
  "ws://localhost:*",
  "http://127.0.0.1:*",
  "ws://127.0.0.1:*",
] as const;

const LOCAL_DEVELOPMENT_RENDERER_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function buildDevelopmentRendererConnections(
  developmentOrigin: string | null | undefined,
): readonly string[] {
  if (!developmentOrigin) return DEVELOPMENT_RENDERER_CONNECTION_FALLBACKS;

  try {
    const origin = new URL(developmentOrigin);
    const isLocalOrigin =
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      LOCAL_DEVELOPMENT_RENDERER_HOSTNAMES.has(origin.hostname) &&
      Boolean(origin.port) &&
      !origin.username &&
      !origin.password;
    if (!isLocalOrigin) return DEVELOPMENT_RENDERER_CONNECTION_FALLBACKS;

    const websocketProtocol = origin.protocol === "https:" ? "wss:" : "ws:";
    return [origin.origin, `${websocketProtocol}//${origin.host}`];
  } catch {
    return DEVELOPMENT_RENDERER_CONNECTION_FALLBACKS;
  }
}

const STATSIG_CONNECT_ORIGINS = [
  "https://api.statsig.com",
  "https://featuregates.org",
  "https://statsigapi.net",
  "https://events.statsigapi.net",
  "https://api.statsigcdn.com",
  "https://featureassets.org",
  "https://assetsconfigcdn.org",
  "https://prodregistryv2.org",
  "https://cloudflare-dns.com",
  "https://beyondwickedmapping.org",
] as const;

export function buildTopLevelRendererCsp(input: {
  mode: "development" | "production";
  developmentOrigin?: string | null;
}): string {
  const developmentConnections =
    input.mode === "development"
      ? buildDevelopmentRendererConnections(input.developmentOrigin)
      : [];
  const developmentScriptSources =
    input.mode === "development" ? [VITE_REACT_REFRESH_PREAMBLE_SHA256] : [];
  const directives = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    `script-src 'self' 'wasm-unsafe-eval' ${developmentScriptSources.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' app: blob: data: https:",
    "media-src 'self' app: blob: data:",
    "worker-src 'self' blob:",
    `connect-src 'self' ${APP_FILESYSTEM_ORIGIN} blob: wss://chatgpt.com wss://ws.chatgpt.com wss://ws.chatgpt-staging.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io ${STATSIG_CONNECT_ORIGINS.join(" ")} ${developmentConnections.join(" ")}`.trim(),
    "frame-src 'self' blob: nodex-mcp-sandbox: https: http:",
    "child-src 'self' blob: nodex-mcp-sandbox: https: http:",
  ];
  return directives.join("; ");
}
