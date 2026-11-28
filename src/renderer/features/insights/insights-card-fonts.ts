import geistMonoUrl from "@nodex/insights-cards/fonts/geist-mono.woff2?url";
import geistSansUrl from "@nodex/insights-cards/fonts/geist-sans.woff2?url";

import type { ShareCardFonts } from "@nodex/insights-cards";

async function fontDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:font/woff2;base64,${btoa(binary)}`;
}

let fonts: Promise<ShareCardFonts | null> | null = null;

/** An image document cannot reach app fonts, so each card embeds them. Plain fonts still draw it. */
export function loadShareCardFonts(): Promise<ShareCardFonts | null> {
  fonts ??= Promise.all([fontDataUrl(geistSansUrl), fontDataUrl(geistMonoUrl)])
    .then(([sans, mono]) => ({ sans, mono }))
    .catch(() => null);
  return fonts;
}
