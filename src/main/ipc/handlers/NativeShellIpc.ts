import {
  getPrimaryCommandAccelerator,
  toElectronAccelerator,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  app,
  nativeImage,
  screen,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import type { NativeContextMenuItem } from "../../../shared/native-context-menu";
import { readSystemDefaultBrowser } from "../../platform/electron/SystemDefaultBrowser";
import {
  createRasterizedMenuIcon,
  getNativeMenuIcon,
  prepareNativeMenuIcons,
} from "../../native-menu-icons";
import { MainConfig } from "../../app/MainConfig";
import { parseExternalNavigationUrl } from "../../external-navigation";
import {
  assertExistingFileOpenPath,
  listAvailableFileLinkOpeners,
  openFileLinkTarget,
  openFileWithApplication,
  readFileOpenApplications,
} from "../../file-link-opener";
import {
  FileOpenApplicationsInputSchema,
  OpenFileWithApplicationInputSchema,
} from "../../../shared/schemas/file-open-applications";
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
  keymap: CommandKeymapState | undefined,
): MenuItemConstructorOptions[] =>
  items.map((item) => {
    if (item.type === "separator") return { type: "separator" };
    const enabled = item.enabled !== false;
    const dataUrl = item.iconUrl ? rasterizedIcons.get(item.iconUrl) : undefined;
    const artwork = dataUrl ? createRasterizedMenuIcon(dataUrl, scaleFactor) : undefined;
    const icon =
      artwork && !artwork.isEmpty()
        ? artwork
        : item.iconKey
          ? getNativeMenuIcon(item.iconKey)
          : undefined;
    const base = {
      id: item.id,
      label: item.label,
      enabled,
      accelerator:
        item.commandId && keymap
          ? toElectronAccelerator(getPrimaryCommandAccelerator(keymap, item.commandId))
          : item.accelerator,
      registerAccelerator: false,
      toolTip: item.tooltip,
      icon,
      role: item.nativeRole,
    } satisfies MenuItemConstructorOptions;
    if (item.type === "submenu") {
      return {
        ...base,
        submenu: menuTemplate(item.submenu, onSelect, rasterizedIcons, scaleFactor, keymap),
      };
    }
    return {
      ...base,
      click: () => {
        if (enabled) onSelect(item.id);
      },
    };
  });

function hasCommandShortcut(items: readonly NativeContextMenuItem[]): boolean {
  return items.some(
    (item) =>
      item.type !== "separator" &&
      (Boolean(item.commandId) || (item.type === "submenu" && hasCommandShortcut(item.submenu))),
  );
}

function collectMenuIconUrls(items: readonly NativeContextMenuItem[]): string[] {
  return items.flatMap((item) => {
    if (item.type === "separator") return [];
    const own = item.iconUrl ? [item.iconUrl] : [];
    return item.type === "submenu" ? [...own, ...collectMenuIconUrls(item.submenu)] : own;
  });
}

/** Rasterizes app artwork at its menu size and isolates failed artwork decodes. */
async function rasterizeMenuIcons(
  sender: WebContents,
  items: readonly NativeContextMenuItem[],
  scaleFactor: number,
): Promise<Map<string, string>> {
  const iconEntries = [...new Set(collectMenuIconUrls(items))];
  if (iconEntries.length === 0) return new Map();

  const script = `(async function () {
    const entries = ${JSON.stringify(iconEntries)};
    const size = Math.max(1, Math.round(16 * ${JSON.stringify(scaleFactor)}));
    const results = await Promise.allSettled(entries.map(async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Unable to rasterize native menu icon");
      const scale = size / Math.max(image.naturalWidth, image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      return [source, canvas.toDataURL("image/png")];
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
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
    // App artwork is optional when the renderer is already being torn down.
    return new Map();
  }
}

export const live: Layer.Layer<
  never,
  never,
  ApplicationSettings | ElectronDesktop | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ApplicationSettings;
    const config = yield* MainConfig;
    const nativeMenuIcons = Effect.promise(() => prepareNativeMenuIcons(config.platform));
    // Glyphs rasterize in the background; handlers register without waiting for them.
    yield* Effect.forkScoped(nativeMenuIcons);
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
          return Effect.all(
            {
              glyphs: nativeMenuIcons,
              rasterizedIcons: run("rasterize-context-menu-icons", () =>
                rasterizeMenuIcons(event.sender, items, scaleFactor),
              ),
              keymap: hasCommandShortcut(items)
                ? settings.snapshot().pipe(
                    Effect.map((snapshot) => snapshot.commandKeymap),
                    Effect.orElseSucceed(() => undefined),
                  )
                : Effect.succeed(undefined),
            },
            { concurrency: "unbounded" },
          ).pipe(
            Effect.andThen(({ rasterizedIcons, keymap }) =>
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
                    keymap,
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
        Effect.andThen(
          run("open-file-link", () =>
            openFileLinkTarget(target, openerId, {
              platform: config.platform,
              shell: desktop.shell,
            }),
          ),
        ),
      ),
    );
    yield* handleQuery("shell:file-link-openers:list-available", (event) =>
      authorize(event).pipe(
        Effect.andThen(
          run("list-available-file-link-openers", async () => listAvailableFileLinkOpeners()),
        ),
      ),
    );
    yield* handleQuery("shell:default-browser:get", (event) =>
      authorize(event).pipe(Effect.andThen(run("read-default-browser", readSystemDefaultBrowser))),
    );
    yield* handleQuery("file-open-applications", (event, input: unknown) =>
      authorize(event).pipe(
        Effect.andThen(
          run("file-open-applications", async () => {
            const { path } = FileOpenApplicationsInputSchema.parse(input);
            return readFileOpenApplications(path, {
              platform: config.platform,
              readIcon: async (appPath) => {
                // A bundle's generic file icon hides its artwork; its thumbnail is the app icon.
                const icon = await nativeImage
                  .createThumbnailFromPath(appPath, { width: 32, height: 32 })
                  .catch(() => app.getFileIcon(appPath, { size: "normal" }));
                return icon.isEmpty() ? null : icon.toDataURL();
              },
            });
          }),
        ),
      ),
    );
    yield* handlePlainCommand("shell:open-file-with-application", (event, input: unknown) =>
      authorize(event).pipe(
        Effect.andThen(
          run("open-file-with-application", async () => {
            const parsed = OpenFileWithApplicationInputSchema.safeParse(input);
            if (!parsed.success) return false;
            return openFileWithApplication(parsed.data, config.platform);
          }),
        ),
      ),
    );
    yield* handlePlainCommand("open-file", (event, target, openerId) =>
      authorize(event).pipe(
        Effect.andThen(
          run("open-file", () =>
            openFileLinkTarget(target, openerId, {
              platform: config.platform,
              shell: desktop.shell,
            }),
          ),
        ),
      ),
    );
    yield* handlePlainCommand("shell:open-external-url", (event, value) =>
      authorize(event).pipe(
        Effect.andThen(
          run("open-external-url", async () => {
            parseExternalNavigationUrl(value);
            await desktop.shell.openExternal(value);
            return true;
          }),
        ),
      ),
    );
    yield* handlePlainCommand("shell:open-path-default", (event, inputPath) =>
      authorize(event).pipe(
        Effect.andThen(
          run("open-path", async () => {
            if (typeof inputPath !== "string" || !isAbsolute(inputPath)) return false;
            const exists = await assertExistingFileOpenPath(inputPath).then(
              () => true,
              () => false,
            );
            if (!exists) return false;
            return (await desktop.shell.openPath(inputPath)) === "";
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
