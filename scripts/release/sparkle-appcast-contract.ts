import { DOMParser } from "@xmldom/xmldom";

import type { SparkleArchitectureUpdateManifest, SparkleFileIdentity } from "./sparkle-manifest";

const SPARKLE_NAMESPACE = "http://www.andymatuschak.org/xml-namespaces/sparkle";
const PRODUCT_MINIMUM_MACOS = /^15(?:\.0){0,2}$/u;

const sparkleText = (item: Element, localName: string): string | null =>
  item.getElementsByTagNameNS(SPARKLE_NAMESPACE, localName).item(0)?.textContent?.trim() || null;

const enclosureMatches = (enclosure: Element, identity: SparkleFileIdentity): boolean =>
  enclosure.getAttribute("url") === identity.url &&
  enclosure.getAttribute("length") === String(identity.bytes) &&
  enclosure.getAttributeNS(SPARKLE_NAMESPACE, "edSignature") === identity.edSignature;

export function verifySparkleAppcastContract(
  xml: string,
  manifest: SparkleArchitectureUpdateManifest,
): void {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Sparkle appcast contract requires valid XML.");
  }
  const matchingItems: Element[] = [];
  const items = document.getElementsByTagName("item");
  for (let index = 0; index < items.length; index += 1) {
    const item = items.item(index);
    if (
      item &&
      sparkleText(item, "shortVersionString") === manifest.target.version &&
      sparkleText(item, "version") === manifest.target.buildVersion
    ) {
      matchingItems.push(item);
    }
  }
  if (matchingItems.length !== 1) {
    throw new Error("Sparkle appcast must contain exactly one target release item.");
  }
  const minimumSystemVersion = sparkleText(matchingItems[0], "minimumSystemVersion");
  if (!minimumSystemVersion || !PRODUCT_MINIMUM_MACOS.test(minimumSystemVersion)) {
    throw new Error("Sparkle appcast target must require macOS 15.0.");
  }

  const fullEnclosures: Element[] = [];
  const deltaEnclosures = new Map<string, Element>();
  const enclosures = matchingItems[0].getElementsByTagName("enclosure");
  for (let index = 0; index < enclosures.length; index += 1) {
    const enclosure = enclosures.item(index);
    if (!enclosure) continue;
    const deltaFrom = enclosure.getAttributeNS(SPARKLE_NAMESPACE, "deltaFrom");
    if (!deltaFrom) {
      fullEnclosures.push(enclosure);
      continue;
    }
    if (deltaEnclosures.has(deltaFrom)) {
      throw new Error(`Sparkle appcast contains duplicate delta source ${deltaFrom}.`);
    }
    deltaEnclosures.set(deltaFrom, enclosure);
  }
  if (fullEnclosures.length !== 1 || !enclosureMatches(fullEnclosures[0], manifest.full)) {
    throw new Error("Sparkle appcast full enclosure does not match its update manifest.");
  }
  if (deltaEnclosures.size !== manifest.deltas.length) {
    throw new Error("Sparkle appcast delta enclosure set does not match its update manifest.");
  }
  for (const delta of manifest.deltas) {
    const enclosure = deltaEnclosures.get(delta.fromBuildVersion);
    if (!enclosure || !enclosureMatches(enclosure, delta)) {
      throw new Error(
        `Sparkle appcast delta from ${delta.fromVersion} does not match its update manifest.`,
      );
    }
  }
}
