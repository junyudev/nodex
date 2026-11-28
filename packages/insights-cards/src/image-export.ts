import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH } from "./cards";

const EXPORT_SCALE = 2;

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
