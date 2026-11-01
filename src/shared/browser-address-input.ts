import { parse } from "tldts";
import { isLocalHostname } from "./browser-url-policy";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const SLASHED_WINDOWS_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:[\\/]/;
const BACKSLASH_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
const SLASH_UNC_PATH_PATTERN = /^\/\/[^/]+\/[^/]+/;

/** Converts typed address input into a destination; trusted navigation URLs bypass this. */
export function normalizeBrowserAddressInput(input: string): string {
  const containedNewline = input.includes("\n");
  const value = input.trim();
  if (value.length === 0) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (/^about:/i.test(value)) return value;
  if (
    isAbsolutePath(value) &&
    !value.startsWith("//") &&
    !(value.startsWith("/") && containedNewline)
  ) {
    return absolutePathToFileUrl(value);
  }
  const candidate = readHostCandidate(value);
  if (candidate && isLocalHostname(candidate.hostname)) return `http://${value}`;
  if (isWebHost(value, candidate)) return `https://${value}`;
  return `https://www.google.com/search?${new URLSearchParams({ q: value }).toString()}`;
}

function isUncPath(path: string): boolean {
  return BACKSLASH_UNC_PATH_PATTERN.test(path) || SLASH_UNC_PATH_PATTERN.test(path);
}

function isAbsolutePath(path: string): boolean {
  return (
    (path.startsWith("/") && !path.startsWith("//")) ||
    WINDOWS_DRIVE_PATH_PATTERN.test(path) ||
    isUncPath(path)
  );
}

function absolutePathToFileUrl(path: string): string {
  const extendedUnc = path.match(/^\\\\\?\\UNC\\(.*)$/i);
  const extendedDrive = path.match(/^\\\\\?\\([a-zA-Z]:[\\/].*)$/);
  let pathname = extendedUnc ? `\\\\${extendedUnc[1]}` : (extendedDrive?.[1] ?? path);
  if (SLASHED_WINDOWS_DRIVE_PATH_PATTERN.test(pathname)) pathname = pathname.slice(1);
  pathname = pathname.replace(/\\/g, "/");
  if (WINDOWS_DRIVE_PATH_PATTERN.test(pathname)) pathname = `/${pathname}`;

  const url = new URL("file:///");
  if (isUncPath(pathname)) {
    const separator = pathname.indexOf("/", 2);
    url.host = pathname.slice(2, separator);
    url.pathname = encodeURI(pathname.slice(separator));
    return url.toString();
  }
  url.pathname = encodeURI(pathname);
  return url.toString();
}

interface HostCandidate {
  readonly hostname: string;
  readonly hasPort: boolean;
}

function readHostCandidate(value: string): HostCandidate | null {
  const separator = value.search(/[/?#]/);
  const host = separator === -1 ? value : value.slice(0, separator);
  if (host.length === 0 || host.includes("@")) return null;
  const ipv6 = host.match(/^(\[[^\]]+\])(?::(\d+))?$/);
  if (ipv6) return { hostname: ipv6[1] ?? "", hasPort: ipv6[2] != null };
  const withPort = host.match(/^([^:]+):(\d+)$/);
  if (withPort) return { hostname: withPort[1] ?? "", hasPort: true };
  if (host.includes(":")) return null;
  return { hostname: host, hasPort: false };
}

function isIpAddress(hostname: string): boolean {
  if (hostname.startsWith("[")) {
    try {
      return Boolean(new URL(`https://${hostname}`));
    } catch {
      return false;
    }
  }
  const segments = hostname.split(".");
  return (
    segments.length === 4 &&
    segments.every((segment) => /^\d+$/.test(segment) && Number(segment) <= 255)
  );
}

function isWebHost(value: string, candidate: HostCandidate | null): boolean {
  if (/\s/.test(value) || !candidate) return false;
  const { hostname, hasPort } = candidate;
  if (hostname.startsWith("[")) return isIpAddress(hostname);
  if (hasPort || hostname.startsWith("www.") || isIpAddress(hostname)) return true;
  const domain = parse(hostname, { allowPrivateDomains: true });
  return domain.domain != null && (domain.isIcann === true || domain.isPrivate === true);
}
