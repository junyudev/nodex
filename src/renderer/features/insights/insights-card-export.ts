import geistMonoUrl from "@/assets/fonts/geist-mono.woff2?url";
import geistSansUrl from "@/assets/fonts/geist-sans.woff2?url";

import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, type ShareCardFonts } from "./insights-cards";

const EXPORT_SCALE = 2;

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

export const svgImageSource = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Draws the same SVG the preview shows, so what you see is what is shared. */
export async function renderCardPng(svg: string): Promise<string> {
  const image = new Image();
  image.src = svgImageSource(svg);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = SHARE_CARD_WIDTH * EXPORT_SCALE;
  canvas.height = SHARE_CARD_HEIGHT * EXPORT_SCALE;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Could not draw the card");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
