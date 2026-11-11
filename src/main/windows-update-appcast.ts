import { DOMParser, type Element } from "@xmldom/xmldom";
import { APP_UPDATE_BUILD_VERSION_PATTERN } from "../shared/app-version";
import { compareAppBuildVersions } from "./app-update-trust";

export const MAX_APPCAST_BYTES = 1024 * 1024;
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle";

export interface WindowsUpdateItem {
  readonly buildVersion: string;
  readonly version: string;
  readonly url: string;
  readonly expectedBytes: number;
  readonly signature: string;
  readonly releaseName?: string;
  readonly releaseDate?: string;
  readonly releaseNotes?: string;
}

const children = (parent: Element, name: string, namespace = ""): Element[] =>
  Array.from(parent.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 && node.localName === name && (node.namespaceURI ?? "") === namespace,
  );
const text = (item: Element, name: string, namespace = ""): string | undefined => {
  const matches = children(item, name, namespace);
  if (matches.length > 1) throw new Error(`Appcast contains duplicate ${name}.`);
  return matches[0]?.textContent?.trim() || undefined;
};

/** No DTDs, entities, recovery parsing, nested enclosures or unbounded feed trees. */
export function selectWindowsUpdate(
  xml: string,
  architecture: "x64" | "arm64",
  runningBuildVersion: string,
): WindowsUpdateItem | null {
  if (Buffer.byteLength(xml) > MAX_APPCAST_BYTES || /<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new Error("Appcast is oversized or contains a forbidden declaration.");
  }
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(message);
    },
  }).parseFromString(xml, "application/xml");
  const rss = document.documentElement;
  if (rss?.tagName !== "rss" || children(rss, "channel").length !== 1) {
    throw new Error("Appcast must contain one RSS channel.");
  }
  compareAppBuildVersions(runningBuildVersion, runningBuildVersion);
  const items = children(children(rss, "channel")[0]!, "item");
  if (items.length > 100) throw new Error("Appcast contains too many items.");
  let newest: WindowsUpdateItem | null = null;
  for (const item of items) {
    const enclosures = children(item, "enclosure").filter(
      (entry) =>
        entry.getAttributeNS(SPARKLE_NS, "os") === "windows" &&
        !entry.hasAttributeNS(SPARKLE_NS, "deltaFrom"),
    );
    for (const enclosure of enclosures) {
      const url = new URL(enclosure.getAttribute("url") ?? "");
      // The architecture-specific immutable asset name supplies the CPU identity.
      if (!url.pathname.endsWith(`-windows-${architecture}.exe`)) continue;
      if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/junyudev\/nodex\/releases\/download\/[^/]+\/Nodex-[^/]+$/u.test(url.pathname)
      ) {
        throw new Error("Windows update must use an immutable Nodex GitHub Release URL.");
      }
      const buildVersion =
        text(item, "version", SPARKLE_NS) ?? enclosure.getAttributeNS(SPARKLE_NS, "version");
      const version =
        text(item, "shortVersionString", SPARKLE_NS) ??
        enclosure.getAttributeNS(SPARKLE_NS, "shortVersionString");
      const length = enclosure.getAttribute("length") ?? "";
      const expectedBytes = Number(length);
      const signature = enclosure.getAttributeNS(SPARKLE_NS, "edSignature") ?? "";
      if (
        !buildVersion ||
        !APP_UPDATE_BUILD_VERSION_PATTERN.test(buildVersion) ||
        !version ||
        version.length > 128 ||
        !/^[1-9]\d*$/u.test(length) ||
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes > MAX_INSTALLER_BYTES ||
        !/^[A-Za-z0-9+/]{86}==$/u.test(signature) ||
        Buffer.from(signature, "base64").toString("base64") !== signature ||
        enclosure.getAttribute("type") !== "application/octet-stream"
      ) {
        throw new Error("Windows update enclosure identity is invalid.");
      }
      if (compareAppBuildVersions(buildVersion, runningBuildVersion) <= 0) continue;
      const candidate: WindowsUpdateItem = {
        buildVersion,
        version,
        url: url.href,
        expectedBytes,
        signature,
        releaseName: text(item, "title"),
        releaseDate: text(item, "pubDate"),
        releaseNotes: text(item, "description"),
      };
      if (newest && compareAppBuildVersions(buildVersion, newest.buildVersion) === 0) {
        if (JSON.stringify(newest) !== JSON.stringify(candidate))
          throw new Error("Appcast has conflicting builds.");
        continue;
      }
      if (!newest || compareAppBuildVersions(buildVersion, newest.buildVersion) > 0)
        newest = candidate;
    }
  }
  return newest;
}
