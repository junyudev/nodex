import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  nativeImage,
  screen,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import type { NativeContextMenuItem } from "../../../shared/native-context-menu";
import {
  buildSessionContextMenuIconSvg,
  getNativeContextMenuIconSvg,
} from "../../../shared/session-context-menu-icons";
import { MainConfig } from "../../app/MainConfig";
import { parseExternalNavigationUrl } from "../../external-navigation";
import { listAvailableFileLinkOpeners, openFileLinkTarget } from "../../file-link-opener";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class NativeShellIpcError extends Schema.TaggedError<NativeShellIpcError>()(
  "NativeShellIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const menuTemplate = (
  items: readonly NativeContextMenuItem[],
  onSelect: (id: string) => void,
  rasterizedIcons: ReadonlyMap<string, string>,
  scaleFactor: number,
): MenuItemConstructorOptions[] =>
  items.map((item) => {
    if (item.type === "separator") return { type: "separator" };
    const enabled = item.enabled !== false;
    const rasterizedIcon = rasterizedIcons.get(menuIconId(item) ?? "");
    const icon =
      item.iconKey || item.iconUrl
        ? rasterizedIcon
          ? createRasterizedMenuIcon(rasterizedIcon, scaleFactor)
          : item.iconKey
            ? nativeImage.createFromDataURL(
                `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildSessionContextMenuIconSvg(item.iconKey))}`,
              )
            : undefined
        : undefined;
    if (process.platform === "darwin" && item.iconKey) icon?.setTemplateImage(true);
    const base = {
      id: item.id,
      label: item.label,
      enabled,
      accelerator: item.accelerator,
      registerAccelerator: false,
      toolTip: item.tooltip,
      icon,
    } satisfies MenuItemConstructorOptions;
    if (item.type === "submenu") {
      return {
        ...base,
        submenu: menuTemplate(item.submenu, onSelect, rasterizedIcons, scaleFactor),
      };
    }
    if (item.type === "checkbox") {
      return {
        ...base,
        type: "checkbox",
        checked: item.checked === true,
        click: () => {
          if (enabled) onSelect(item.id);
        },
      };
    }
    return {
      ...base,
      click: () => {
        if (enabled) onSelect(item.id);
      },
    };
  });

function createRasterizedMenuIcon(dataUrl: string, scaleFactor: number) {
  if (scaleFactor <= 1) return nativeImage.createFromDataURL(dataUrl);
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor, dataURL: dataUrl });
  return icon;
}

interface MenuIconSource {
  readonly id: string;
  readonly source: string;
  readonly template: boolean;
}

function menuIconId(item: Exclude<NativeContextMenuItem, { type: "separator" }>): string | null {
  if (item.iconKey) return `key:${item.iconKey}`;
  if (item.iconUrl) return `url:${item.iconUrl}`;
  return null;
}

function collectMenuIconSources(items: readonly NativeContextMenuItem[]): MenuIconSource[] {
  const sources = new Map<string, MenuIconSource>();
  const visit = (menuItems: readonly NativeContextMenuItem[]) => {
    for (const item of menuItems) {
      if (item.type === "separator") continue;
      const id = menuIconId(item);
      if (id && !sources.has(id)) {
        sources.set(
          id,
          item.iconKey
            ? { id, source: getNativeContextMenuIconSvg(item.iconKey), template: true }
            : { id, source: item.iconUrl!, template: false },
        );
      }
      if (item.type === "submenu") visit(item.submenu);
    }
  };
  visit(items);
  return [...sources.values()];
}

/** Rasterizes against the renderer's live foreground color so macOS receives crisp 16 pt assets. */
async function rasterizeMenuIcons(
  sender: WebContents,
  items: readonly NativeContextMenuItem[],
  scaleFactor: number,
): Promise<Map<string, string>> {
  const iconEntries = collectMenuIconSources(items);
  if (iconEntries.length === 0) return new Map();

  const script = `(async function () {
    const entries = ${JSON.stringify(iconEntries)};
    const color = getComputedStyle(document.documentElement).color;
    const size = Math.max(1, Math.round(16 * ${JSON.stringify(scaleFactor)}));
    return await Promise.all(entries.map(async ({ id, source, template }) => {
      const image = new Image();
      image.src = template
        ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source.replaceAll("currentColor", color))
        : source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Unable to rasterize native menu icon");
      context.drawImage(image, 0, 0, size, size);
      return [id, canvas.toDataURL("image/png")];
    }));
  })()`;

  try {
    const result = (await sender.executeJavaScript(script, true)) as unknown;
    if (!Array.isArray(result)) return new Map();
    return new Map(
      result.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    // The SVG fallback below keeps menus usable if a renderer is already being torn down.
    return new Map();
  }
}

export const live: Layer.Layer<
  never,
  never,
  ElectronDesktop | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const desktop = yield* ElectronDesktop;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const { handlePlainCommand, handleQuery } = ipc;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Native desktop", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Native desktop access requires an active Nodex window");
          }
        },
        catch: (cause) => new NativeShellIpcError({ operation: "authorize-renderer", cause }),
      });
    const run = <A>(operation: string, task: () => Promise<A>) =>
      Effect.tryPromise({
        try: task,
        catch: (cause) => new NativeShellIpcError({ operation, cause }),
      });

    yield* handlePlainCommand("native-context-menu:show", (event, items, options) =>
      authorize(event).pipe(
        Effect.andThen(() => {
          const owner = windows.get(event.sender.id);
          const scaleFactor = owner
            ? Math.max(1, screen.getDisplayMatching(owner.getBounds()).scaleFactor)
            : 1;
          return run("rasterize-context-menu-icons", () =>
            rasterizeMenuIcons(event.sender, items, scaleFactor),
          ).pipe(
            Effect.andThen((rasterizedIcons) =>
              Effect.callback<string | null>((resume) => {
                let selectedId: string | null = null;
                const menu = desktop.menu.buildFromTemplate(
                  menuTemplate(
                    items,
                    (id) => {
                      selectedId = id;
                    },
                    rasterizedIcons,
                    scaleFactor,
                  ),
                );
                menu.popup({
                  window: owner ?? undefined,
                  x: typeof options?.x === "number" ? Math.round(options.x) : undefined,
                  y: typeof options?.y === "number" ? Math.round(options.y) : undefined,
                  positioningItem: options?.positioningItem,
                  callback: () => resume(Effect.succeed(selectedId)),
                });
                return Effect.sync(() => menu.closePopup(owner ?? undefined));
              }),
            ),
          );
        }),
      ),
    );
    yield* handlePlainCommand("shell:open-file-link", (event, target, openerId) =>
      authorize(event).pipe(
        Effect.andThen(run("open-file-link", () => openFileLinkTarget(target, openerId))),
      ),
    );
    yield* handleQuery("shell:file-link-openers:list-available", (event) =>
      authorize(event).pipe(
        Effect.andThen(
          run("list-available-file-link-openers", async () => listAvailableFileLinkOpeners()),
        ),
      ),
    );
    yield* handlePlainCommand("open-file", (event, target, openerId) =>
      authorize(event).pipe(
        Effect.andThen(run("open-file", () => openFileLinkTarget(target, openerId))),
      ),
    );
    yield* handlePlainCommand("shell:open-external-url", (event, value) =>
      authorize(event).pipe(
        Effect.andThen(
          run("open-external-url", async () => {
            await desktop.shell.openExternal(parseExternalNavigationUrl(value).toString());
            return true;
          }),
        ),
      ),
    );
    yield* handlePlainCommand("shell:open-path-default", (event, inputPath) =>
      authorize(event).pipe(
        Effect.andThen(
          run("open-path", async () => {
            const path = inputPath.trim();
            if (!isAbsolute(path)) return false;
            return (await desktop.shell.openPath(path)) === "";
          }),
        ),
      ),
    );
    yield* handleQuery("shell:path-context:get", (event) =>
      authorize(event).pipe(
        Effect.as({
          homeDirectory: homedir(),
          separator: sep === "\\" ? ("\\" as const) : ("/" as const),
        }),
      ),
    );
  }),
);
