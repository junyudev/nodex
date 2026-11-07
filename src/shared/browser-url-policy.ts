/**
 * URL classification shared by link routing, Browser navigation and external opening.
 *
 * Each predicate answers one question for one caller family; none of them is a universal
 * Browser allowlist. Ordinary Browser loads are not filtered by scheme at all, an Agent that
 * controls a page is limited to `isBrowserUseNavigationUrl`, and the system opener accepts
 * `isExternallyOpenableUrl`.
 */

export type LinkOpenTarget = "in-app-browser" | "external-browser";

/** The declared default of both link destination settings. */
export const DEFAULT_LINK_OPEN_TARGET: LinkOpenTarget = "in-app-browser";

const BROWSER_HTML_FILE_PATTERN = /\.html?$/i;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
const EXTERNAL_APP_PROTOCOLS = new Set(["mailto:", "sms:", "tel:"]);
const VSCODE_LINK_HOSTS = new Set(["file", "vscode-remote"]);
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const SLASHED_WINDOWS_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:[\\/]/;
const BACKSLASH_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
const SLASH_UNC_PATH_PATTERN = /^\/\/[^/]+\/[^/]+/;
const MAX_PASSWORD_BROKER_URL_LENGTH = 32_768;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A path the Browser renders as a document when a file link opens it. */
export function isBrowserHtmlFilePath(path: string): boolean {
  return BROWSER_HTML_FILE_PATTERN.test(path);
}

/** Loopback names, including every `*.localhost` subdomain. */
export function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized.endsWith(".localhost") || LOCAL_HOSTNAMES.has(normalized);
}

export function isHttpUrl(url: string): boolean {
  const protocol = parseUrl(url)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

/** HTTP(S) served from this device. */
export function isLocalHttpUrl(url: string): boolean {
  return readLocalHttpPort(url) !== null;
}

/** The port of a local HTTP(S) URL, defaulting by scheme; null for anything else. */
export function readLocalHttpPort(url: string): number | null {
  const parsed = parseUrl(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  if (!isLocalHostname(parsed.hostname)) return null;
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
}

function normalizeFileUrlPathname(pathname: string): string {
  const slashed = pathname.replace(/\\/g, "/").replace(/^\/{3,}/, "//");
  return SLASHED_WINDOWS_DRIVE_PATH_PATTERN.test(slashed) ? slashed.slice(1) : slashed;
}

function isUncPath(path: string): boolean {
  return BACKSLASH_UNC_PATH_PATTERN.test(path) || SLASH_UNC_PATH_PATTERN.test(path);
}

/** A `file:` URL on this device: no host other than `localhost`, and not a network share. */
export function isLocalFileUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (hostname.length > 0 && hostname !== "localhost") return false;
  const pathname = normalizeFileUrlPathname(url.pathname);
  return WINDOWS_DRIVE_PATH_PATTERN.test(pathname) || !isUncPath(pathname);
}

/** Local development sites and local files, which follow the local URL destination. */
export function isLocalUrl(url: string): boolean {
  if (isLocalHttpUrl(url)) return true;
  const parsed = parseUrl(url);
  return parsed?.protocol === "file:" && isLocalFileUrl(parsed);
}

function isPasswordBrokerUrl(url: string): boolean {
  if (url.length > MAX_PASSWORD_BROKER_URL_LENGTH) return false;
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const reference = parsed.searchParams.get("access_request_reference");
  return (
    parsed.protocol === "onepassword:" &&
    parsed.hostname === "grant-brokered-access" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    parsed.pathname === "" &&
    parsed.hash === "" &&
    parsed.searchParams.size === 1 &&
    reference !== null &&
    /^[A-Za-z0-9_-]+$/.test(reference)
  );
}

/** Mail, phone and message links, plus VS Code file and remote links, belong to other apps. */
export function isExternalAppUrl(url: URL): boolean {
  if (url.protocol === "vscode:" || url.protocol === "vscode-insiders:")
    return (
      url.username.length === 0 && url.password.length === 0 && VSCODE_LINK_HOSTS.has(url.host)
    );
  return EXTERNAL_APP_PROTOCOLS.has(url.protocol);
}

/** URLs the system may open outside Nodex. */
export function isExternallyOpenableUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const { protocol } = parsed;
  return (
    protocol === "file:" ||
    protocol === "http:" ||
    protocol === "https:" ||
    isPasswordBrokerUrl(url) ||
    isExternalAppUrl(parsed)
  );
}

/** What a Browser error page may hand to the system browser: HTTPS, or HTTP on this device. */
export function isErrorPageExternalUrl(url: string): boolean {
  const protocol = parseUrl(url)?.protocol;
  return protocol === "https:" || (protocol === "http:" && isLocalUrl(url));
}

/** Where an Agent that controls a Browser page may navigate it. */
export function isBrowserUseNavigationUrl(url: string): boolean {
  if (url === "about:blank") return true;
  return isHttpUrl(url);
}

/** What an Agent may show the user in a Browser tab: the web, or a file on this device. */
export function isAgentPresentedBrowserUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  return parsed.protocol === "file:" ? isLocalFileUrl(parsed) : isHttpUrl(url);
}

/** Whether two URLs load the same document; a fragment only scrolls within it. */
export function isSameBrowserDocument(left: string, right: string): boolean {
  const [first, second] = [parseUrl(left), parseUrl(right)];
  if (!first || !second) return false;
  first.hash = "";
  second.hash = "";
  return first.href === second.href;
}

export type LinkRouteTarget =
  | { readonly type: "url"; readonly url: string }
  | {
      readonly type: "file";
      readonly path: string;
      /** An explicit app the user chose to open the file with. */
      readonly target?: string | null;
      /** A line in the file, which an editor rather than the Browser must show. */
      readonly location?: unknown;
    };

export interface LinkDestinationPreferences {
  readonly openLinkInTarget?: LinkOpenTarget;
  readonly openLocalUrlInTarget?: LinkOpenTarget;
}

/**
 * Whether a link opens in the in-app Browser. Local HTML files always do; local sites follow
 * the local URL destination and other HTTP(S) links the web destination.
 */
export function shouldOpenLinkInBrowser(
  input: {
    readonly browserAvailable: boolean;
    readonly link: LinkRouteTarget;
  } & LinkDestinationPreferences,
): boolean {
  if (!input.browserAvailable) return false;
  const {
    link,
    openLinkInTarget = DEFAULT_LINK_OPEN_TARGET,
    openLocalUrlInTarget = DEFAULT_LINK_OPEN_TARGET,
  } = input;
  if (link.type === "file")
    return link.target == null && link.location == null && isBrowserHtmlFilePath(link.path);
  return isLocalUrl(link.url)
    ? openLocalUrlInTarget === "in-app-browser"
    : openLinkInTarget === "in-app-browser" && isHttpUrl(link.url);
}

/**
 * The destination of a URL. An explicit or app-owned external request always leaves Nodex; an
 * explicit target replaces both preferences but cannot open what the Browser cannot show.
 */
export function resolveLinkOpenTarget(
  input: {
    readonly browserAvailable: boolean;
    readonly url: string;
    readonly openTarget?: LinkOpenTarget;
    readonly useExternalBrowser?: boolean;
  } & LinkDestinationPreferences,
): LinkOpenTarget {
  if (input.useExternalBrowser === true || input.openTarget === "external-browser")
    return "external-browser";
  return shouldOpenLinkInBrowser({
    browserAvailable: input.browserAvailable,
    link: { type: "url", url: input.url },
    openLinkInTarget: input.openTarget ?? input.openLinkInTarget,
    openLocalUrlInTarget: input.openTarget ?? input.openLocalUrlInTarget,
  })
    ? "in-app-browser"
    : "external-browser";
}
