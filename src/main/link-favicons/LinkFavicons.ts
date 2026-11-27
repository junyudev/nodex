import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";
import {
  linkFaviconHostSchema,
  resolveLinkSite,
  type LinkFaviconResult,
} from "../../shared/link-site";
import { MainConfig } from "../app/MainConfig";
import { linkFaviconDiskCache, makeLinkFaviconRequest } from "../platform/node/link-favicon-io";
import { ApplicationSettings } from "../settings/ApplicationSettings";

const none = { status: "none" } as const;
const day = 24 * 60 * 60 * 1000;

export class LinkFavicons extends Context.Service<
  LinkFavicons,
  { readonly read: (hostname: unknown) => Effect.Effect<LinkFaviconResult> }
>()("nodex/main/link-favicons/LinkFavicons") {}

export const make = Effect.fn("LinkFavicons.make")(function* (options: {
  readonly profilePath: string;
  readonly enabled: Effect.Effect<boolean>;
  readonly fetch: typeof globalThis.fetch;
}) {
  const cache = linkFaviconDiskCache(join(options.profilePath, "cache", "link-favicons"));
  const request = makeLinkFaviconRequest(options.fetch);
  const permits = yield* Semaphore.make(4);

  const fetchAndCache = Effect.fnUntraced(function* (host: string) {
    // A lookup queued behind another host may have been disabled in the meantime.
    if (!(yield* options.enabled)) return none;
    const result = yield* request(host).pipe(
      Effect.timeout("4 seconds"),
      Effect.orElseSucceed(() => none),
    );
    const expiresAt = (yield* Clock.currentTimeMillis) + (result.status === "ready" ? 30 : 1) * day;
    yield* cache.write(host, { expiresAt, result });
    return result;
  });

  const pending = yield* RcMap.make({
    lookup: Effect.fnUntraced(function* (host: string) {
      const cached = yield* cache.read(host);
      if (cached && cached.expiresAt > (yield* Clock.currentTimeMillis)) return cached.result;
      return yield* permits.withPermit(fetchAndCache(host));
    }),
  });

  const read = Effect.fnUntraced(function* (hostname: unknown) {
    const host = linkFaviconHostSchema.safeParse(hostname);
    if (!host.success || resolveLinkSite(`https://${host.data}`)?.kind !== "favicon") return none;
    if (!(yield* options.enabled)) return none;
    return yield* Effect.scoped(RcMap.get(pending, host.data));
  });
  return LinkFavicons.of({ read });
});

export const live = Layer.effect(
  LinkFavicons,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const settings = yield* ApplicationSettings;
    return yield* make({
      profilePath: config.nodexHome,
      enabled: settings.fetchLinkFavicons,
      fetch: globalThis.fetch,
    });
  }),
);
