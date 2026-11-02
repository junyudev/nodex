import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BrowserSiteInfo } from "../../shared/browser-profile";
import type { BrowserSidebarTabIdentity } from "../../shared/browser-sidebar";
import type { BrowserSessionPermissions } from "./browser-session-permissions";

interface BrowserSiteInfoTabReader {
  readonly getTabSnapshot: (
    identity: BrowserSidebarTabIdentity,
  ) => { readonly url: string; readonly webContentsId?: number | null } | null;
}

interface BrowserSiteInfoCookieStore {
  readonly get: (filter: { readonly url: string }) => Promise<unknown[]>;
}

export class BrowserSiteInfoRuntimeError extends Schema.TaggedError<BrowserSiteInfoRuntimeError>()(
  "BrowserSiteInfoRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface BrowserSiteInfoRuntime {
  readonly get: (
    identity: BrowserSidebarTabIdentity,
  ) => Effect.Effect<BrowserSiteInfo, BrowserSiteInfoRuntimeError>;
}

const runtimeError = (operation: string, cause: unknown): BrowserSiteInfoRuntimeError =>
  new BrowserSiteInfoRuntimeError({ operation, cause });

export const makeBrowserSiteInfoRuntime = (
  tabs: BrowserSiteInfoTabReader,
  cookies: BrowserSiteInfoCookieStore,
  permissions: Pick<BrowserSessionPermissions, "sitePermissions">,
): BrowserSiteInfoRuntime => ({
  get: (identity) =>
    Effect.gen(function* () {
      const tab = tabs.getTabSnapshot(identity);
      if (!tab) {
        return yield* new BrowserSiteInfoRuntimeError({
          operation: "resolve-tab",
          cause: new Error("Browser tab is not registered"),
        });
      }
      const site = parseSiteUrl(tab.url);
      const cookieCount = site
        ? yield* Effect.tryPromise({
            try: () => cookies.get({ url: site.url.href }).then((values) => values.length),
            catch: (cause) => runtimeError("read-cookies", cause),
          })
        : 0;
      return {
        ...identity,
        url: tab.url,
        origin: site?.url.origin ?? null,
        connection: site?.connection ?? "none",
        cookieCount,
        permissions: site
          ? permissions.sitePermissions(tab.webContentsId ?? undefined, site.url.origin)
          : [],
      };
    }),
});

const parseSiteUrl = (
  value: string,
): { readonly url: URL; readonly connection: BrowserSiteInfo["connection"] } | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const local =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  return {
    url,
    connection: local ? "local" : url.protocol === "https:" ? "secure" : "insecure",
  };
};
