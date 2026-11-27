import { nativeImage, nativeTheme, type NativeImage } from "electron";
import type { NativeContextMenuIconKey } from "../shared/native-context-menu";

const icons = new Map<NativeContextMenuIconKey, { light: NativeImage; dark: NativeImage }>();

let preparation: Promise<void> | null = null;

/**
 * Rasterizes the shared glyphs once, off the startup path. Main-built menus are synchronous and
 * show a row without its glyph until this settles; renderer-requested menus await it.
 */
export function prepareNativeMenuIcons(platform: string): Promise<void> {
  preparation ??= rasterizeNativeMenuIcons(platform);
  return preparation;
}

async function rasterizeNativeMenuIcons(platform: string): Promise<void> {
  // The native shell starts behind the startup window. Keep the glyphs and rasterizer out
  // of the code Main evaluates to show that window.
  const sources = await Promise.all([
    import("sharp"),
    import("../shared/session-context-menu-icons"),
  ]).catch(() => null);
  if (!sources) return;
  const [{ default: sharp }, { SESSION_CONTEXT_MENU_ICON_SVG_BY_KEY }] = sources;
  const template = platform === "darwin";
  const fit = { fit: "contain", background: "#0000" } as const;
  const rasterize = async (svg: string, color: string) => {
    const source = Buffer.from(svg.replaceAll("currentColor", color));
    const [normal, retina] = await Promise.all([
      sharp(source).resize(16, 16, fit).png().toBuffer(),
      sharp(source, { density: 144 }).resize(32, 32, fit).png().toBuffer(),
    ]);
    const icon = nativeImage.createFromBuffer(normal);
    icon.addRepresentation({ scaleFactor: 2, buffer: retina });
    if (template) icon.setTemplateImage(true);
    return icon;
  };
  const entries = Object.entries(SESSION_CONTEXT_MENU_ICON_SVG_BY_KEY) as [
    NativeContextMenuIconKey,
    string,
  ][];
  await Promise.allSettled(
    entries.map(async ([key, svg]) => {
      const light = await rasterize(svg, "#000");
      const dark = template ? light : await rasterize(svg, "#fff");
      icons.set(key, { light, dark });
    }),
  );
}

export function getNativeMenuIcon(key: NativeContextMenuIconKey): NativeImage | undefined {
  const icon = icons.get(key);
  if (!icon) return undefined;
  return nativeTheme.shouldUseDarkColors ? icon.dark : icon.light;
}

export function createRasterizedMenuIcon(dataUrl: string, scaleFactor: number): NativeImage {
  if (scaleFactor <= 1) return nativeImage.createFromDataURL(dataUrl);
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor, dataURL: dataUrl });
  return icon;
}
