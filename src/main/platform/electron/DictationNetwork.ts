import type { Agent } from "node:http";
import { app, session } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { DictationStreamProxyMode } from "../../../shared/dictation-stream-transport";

export class DictationNetworkError extends Schema.TaggedError<DictationNetworkError>()(
  "DictationNetworkError",
  {
    operation: Schema.Literals([
      "resolve-proxy",
      "unsupported-proxy",
      "invalid-proxy",
      "create-proxy-agent",
    ]),
  },
) {}

export interface DictationNetworkRoute {
  readonly agent?: Agent;
  readonly proxyMode: DictationStreamProxyMode;
}

export class DictationNetwork extends Context.Service<
  DictationNetwork,
  {
    readonly acceptLanguage: string | undefined;
    readonly prepare: (
      url: string,
    ) => Effect.Effect<DictationNetworkRoute, DictationNetworkError, Scope.Scope>;
  }
>()("nodex/main/platform/electron/DictationNetwork") {}

type ProxyRoute =
  | { readonly proxyMode: "direct" }
  | { readonly proxyMode: "http" | "https" | "socks"; readonly url: URL };

/** The first PAC route is authoritative: never bypass a configured proxy by choosing later DIRECT. */
export const parseDictationProxyRoute = (proxy: string): ProxyRoute => {
  const first = proxy.split(";")[0]?.trim();
  if (first === "DIRECT") return { proxyMode: "direct" };
  if (!first) throw new DictationNetworkError({ operation: "invalid-proxy" });
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/u.exec(first);
  if (!match) throw new DictationNetworkError({ operation: "unsupported-proxy" });
  const [, kind, address] = match;
  if (!address || !/^(\[[0-9a-fA-F:.]+\]|[^:/?#@;\s]+):\d+$/u.test(address)) {
    throw new DictationNetworkError({ operation: "invalid-proxy" });
  }
  const mode = kind === "PROXY" ? "http" : kind === "HTTPS" ? "https" : "socks";
  // Chromium resolves SOCKS4 locally and SOCKS5 at the proxy; retain that DNS boundary.
  const protocol = mode === "socks" ? (kind === "SOCKS5" ? "socks5h" : "socks4") : mode;
  let url: URL;
  try {
    url = new URL(`${protocol}://${address}`);
  } catch {
    throw new DictationNetworkError({ operation: "invalid-proxy" });
  }
  const port = Number(address.slice(address.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !url.hostname) {
    throw new DictationNetworkError({ operation: "invalid-proxy" });
  }
  return { proxyMode: mode, url };
};

export const makeDictationNetwork = (options: {
  readonly acceptLanguage: string | undefined;
  readonly resolveProxy: (url: string) => Promise<string>;
}): DictationNetwork["Service"] => ({
  acceptLanguage: options.acceptLanguage,
  prepare: Effect.fn("DictationNetwork.prepare")(function* (url: string) {
    // Resolve the routed WSS URL, so Chromium's scheme-specific PAC and bypass rules stay effective.
    const proxy = yield* Effect.tryPromise({
      try: () => options.resolveProxy(url),
      catch: () => new DictationNetworkError({ operation: "resolve-proxy" }),
    });
    const route = yield* Effect.try({
      try: () => parseDictationProxyRoute(proxy),
      catch: (error) =>
        Schema.is(DictationNetworkError)(error)
          ? error
          : new DictationNetworkError({ operation: "invalid-proxy" }),
    });
    if (route.proxyMode === "direct") return { proxyMode: route.proxyMode };
    const signal = yield* Effect.abortSignal;
    const agent = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          route.proxyMode === "socks"
            ? new SocksProxyAgent(route.url, { socketOptions: { signal } })
            : new HttpsProxyAgent(route.url, { signal }),
        catch: () => new DictationNetworkError({ operation: "create-proxy-agent" }),
      }),
      (agent) => Effect.sync(() => agent.destroy()),
    );
    return { proxyMode: route.proxyMode, agent };
  }),
});

export const live: Layer.Layer<DictationNetwork> = Layer.effect(
  DictationNetwork,
  Effect.sync(() =>
    makeDictationNetwork({
      acceptLanguage: app.getPreferredSystemLanguages()[0],
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    }),
  ),
);
