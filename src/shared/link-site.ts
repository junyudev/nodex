import { z } from "zod";
import { isLocalHostname } from "./browser-url-policy";
import {
  resolveBrowserWebsiteSourceIconId,
  type BrowserWebsiteSourceIconId,
} from "./browser-website-source";

/**
 * Where a web link goes, as its icon tells it.
 *
 * - `glyph`: a site Nodex draws itself, such as GitHub or Linear. No network.
 * - `favicon`: any other public site; its icon is fetched once per host and kept on this device.
 * - `private`: this device or a private network. Its name never leaves the device, so it gets the
 *   generic web glyph.
 */
export type LinkSite =
  | { readonly kind: "glyph"; readonly glyph: BrowserWebsiteSourceIconId; readonly host: string }
  | { readonly kind: "favicon"; readonly host: string }
  | { readonly kind: "private"; readonly host: string };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/** Hosts that only mean something on the reader's own networks. */
function isPrivateHost(host: string): boolean {
  if (isLocalHostname(host)) return true;
  if (host.startsWith("[") || host.includes(":")) return true;
  if (!host.includes(".")) return true;
  if (/\.(?:local|lan|home|internal|intranet|corp|localdomain|home\.arpa)$/u.test(host))
    return true;
  const ipv4 = IPV4.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The site an HTTP(S) link belongs to, or null for every other kind of link. */
export function resolveLinkSite(href: string): LinkSite | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (!host) return null;
  if (isPrivateHost(host)) return { kind: "private", host };
  const glyph = resolveBrowserWebsiteSourceIconId(url.href);
  return glyph ? { kind: "glyph", glyph, host } : { kind: "favicon", host };
}

/** A public hostname a favicon can be asked for: lowercase, dotted, no port or credentials. */
export const linkFaviconHostSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/u);

export type LinkFaviconResult =
  /** A small raster image as a data URL. */
  | { readonly status: "ready"; readonly dataUrl: string }
  /** No icon: the site has none, fetching is off, or it could not be fetched recently. */
  | { readonly status: "none" };
