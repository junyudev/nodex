import { randomBytes } from "node:crypto";
import { session, type WebContents, type WebPreferences } from "electron";
import * as Effect from "effect/Effect";
import {
  VISUAL_PARTITION_PREFIX,
  VISUAL_SCHEME,
  type VisualRenderFrame,
  type VisualRenderReply,
  type VisualRenderRequest,
  type VisualTheme,
} from "../../shared/visual/bridge";
import type { VisualProgram } from "../../shared/visual/compiler";
import { VISUAL_LIMITS, type VisualRows } from "../../shared/visual/contract";
import {
  denyGuestPermissionsAndDownloads,
  forceIsolatedGuestPreferences,
  lockGuestNavigation,
} from "../guests/isolated-guest-policy";
import { configurePageFileHtmlNetwork } from "../page-files/page-file-html-network";

interface GuestParams {
  src?: string;
  partition?: string;
  preload?: string;
  nodeintegration?: string;
  webpreferences?: string;
}

const MEASUREMENT_WORLD = 1010;
const maxRevisions = 24;

export const prepareVisualGuest = Effect.fn("VisualGuest.prepare")(function* () {
  const modules = yield* Effect.tryPromise(() => import("virtual:nodex-visual-assets"));
  const grant = randomBytes(32).toString("hex");
  const origin = `${VISUAL_SCHEME}://${grant}`;
  const url = `${origin}/`;
  const partition = VISUAL_PARTITION_PREFIX + grant;
  const isolated = session.fromPartition(partition, { cache: false });
  yield* configurePageFileHtmlNetwork(isolated);
  denyGuestPermissionsAndDownloads(isolated);

  let activeModule: { path: string; code: string } | undefined;
  let contents: WebContents | undefined;
  let closed = false;
  let measuring = false;
  let revision = 0;
  const nonce = randomBytes(24).toString("base64");
  const policy = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "img-src data:",
  ].join("; ");
  const document = `<!doctype html><html><head><meta charset="utf-8"><title>Visual</title>
    <style>html,body{margin:0}body{background:var(--background);color:var(--foreground);
    font:var(--font-size-base) var(--font-sans)}#visual{display:flow-root;width:max-content;
    max-width:100%;overflow:hidden}svg{display:block;max-width:100%}
    #visual>svg,#visual>div>svg{height:auto}</style>
    <script type="importmap" nonce="${nonce}">${JSON.stringify({ imports: modules.importMap })}</script>
    <script type="module" src="/runtime.js"></script></head><body><div id="visual"></div></body></html>`;
  const allowed = (raw: string, method: string) => {
    if (closed || method !== "GET" || !raw.startsWith(origin + "/")) return undefined;
    const candidate = new URL(raw);
    if (candidate.search || candidate.username || candidate.password) return undefined;
    const path = candidate.pathname;
    return path === "/" || Object.hasOwn(modules.assets, path) || path === activeModule?.path
      ? path
      : undefined;
  };
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: allowed(details.url, details.method) === undefined }),
  );
  isolated.protocol.handle(VISUAL_SCHEME, (request) => {
    const path = allowed(request.url, request.method);
    if (!path) return new Response(null, { status: 404 });
    const body =
      path === "/"
        ? document
        : path === activeModule?.path
          ? activeModule.code
          : modules.assets[path];
    return new Response(body, {
      headers: {
        "content-type":
          path === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
        "content-security-policy": policy,
        "x-content-type-options": "nosniff",
        "x-dns-prefetch-control": "off",
        "cache-control": "no-store",
      },
    });
  });

  const close = () => {
    if (closed) return;
    closed = true;
    activeModule = undefined;
    isolated.protocol.unhandle(VISUAL_SCHEME);
    if (contents && !contents.isDestroyed()) contents.close();
  };

  return {
    grant: { grant, url, partition },
    session: isolated,
    canRender: () => revision < maxRevisions,
    close,
    destroyed: () => {
      contents = undefined;
      close();
    },
    preferences: (preferences: WebPreferences, params: GuestParams = {}) => {
      forceIsolatedGuestPreferences(preferences, params, isolated);
      Object.assign(preferences, { devTools: false, backgroundThrottling: false, partition });
      delete preferences.additionalArguments;
    },
    bind: (guest: WebContents) => {
      contents = guest;
      guest.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      lockGuestNavigation({ guest, documentUrl: url, allowSubframe: () => false });
      guest.on("render-process-gone", close);
    },
    /** Only the platform adapter can load a module, invoke rendering or take measurements. */
    render: (code: string, program: VisualProgram, rows: VisualRows, theme: VisualTheme) =>
      Effect.tryPromise({
        try: async (): Promise<VisualRenderReply> => {
          if (closed || !contents || contents.isDestroyed())
            throw new Error("Visual guest is unavailable");
          if (measuring) throw new Error("A Visual render is already in progress");
          if (revision >= maxRevisions) throw new Error("Visual guest needs to be reopened");
          measuring = true;
          const id = ++revision;
          const guest = contents;
          const modulePath = `/source-${id}.js`;
          activeModule = { path: modulePath, code };
          const request: VisualRenderRequest = {
            revision: id,
            modulePath,
            sources: rows,
            keys: program.figures.map(({ sources }) =>
              Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, value.key])),
            ),
            params: program.figures.map(({ params }) =>
              Object.fromEntries(
                Object.entries(params).map(([name, value]) => [name, value.value]),
              ),
            ),
            theme,
          };
          try {
            const error: unknown = await guest.executeJavaScript(
              `globalThis.renderNodexVisual(JSON.parse(${JSON.stringify(JSON.stringify(request))}))`,
            );
            if (error !== null) return readGuestError(error, id);
            const frame = (await guest.executeJavaScriptInIsolatedWorld(MEASUREMENT_WORLD, [
              {
                code: `if (!globalThis.measureNodexVisual) { ${modules.measureScript} }\nglobalThis.measureNodexVisual(${id})`,
              },
            ])) as VisualRenderFrame;
            if (
              !frame ||
              frame.revision !== id ||
              typeof frame.svg !== "string" ||
              frame.svg.length > 8 * 1024 * 1024
            )
              throw new Error("Visual measurement exceeded its budget");
            return { status: "rendered", frame };
          } finally {
            activeModule = undefined;
            measuring = false;
          }
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error("Visual rendering failed")),
      }).pipe(
        Effect.timeout(`${VISUAL_LIMITS.renderMilliseconds} millis`),
        Effect.onError(() =>
          Effect.sync(() => {
            // A stalled JavaScript task cannot acknowledge a graceful close.
            if (contents && !contents.isDestroyed()) contents.forcefullyCrashRenderer();
            close();
          }),
        ),
      ),
  };
});

function readGuestError(value: unknown, revision: number): VisualRenderReply {
  const error: { message?: unknown; location?: { line?: unknown; column?: unknown } } =
    typeof value === "object" && value !== null ? value : {};
  const { line, column } = error.location ?? {};
  return {
    status: "error",
    revision,
    message:
      typeof error.message === "string" ? error.message.slice(0, 500) : "Visual rendering failed",
    location:
      typeof line === "number" &&
      typeof column === "number" &&
      Number.isSafeInteger(line) &&
      Number.isSafeInteger(column)
        ? { line, column }
        : undefined,
  };
}

export type VisualGuest = Effect.Success<ReturnType<typeof prepareVisualGuest>>;
