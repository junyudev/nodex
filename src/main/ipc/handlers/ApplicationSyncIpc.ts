import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainEvent } from "electron";
import { lstatSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { parseAssetSource } from "../../../shared/assets";
import { CLIPBOARD_INSPECT_PASTE_SYNC_CHANNEL } from "../../../shared/clipboard-paste";
import {
  FILE_PATH_INSPECT_SYNC_CHANNEL,
  MANAGED_ASSET_RESOLVE_PATH_SYNC_CHANNEL,
  MANAGED_BLOB_RESOLVE_PATH_SYNC_CHANNEL,
  PRELOAD_FILE_PATH_MAX_LENGTH,
} from "../../../shared/preload-file-access";
import { MainConfig } from "../../app/MainConfig";
import { inspectClipboardPasteItems } from "../../clipboard-paste-inspector";
import { resolveAssetPath } from "../../local-store/assets";
import { resolveManagedBlobPath } from "../../local-store/managed-blob-path";
import { captureMainException } from "../../observability/sentry-main";
import { ElectronSyncIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { ElectronClipboard } from "../../platform/electron/ElectronClipboard";

export const live: Layer.Layer<
  never,
  never,
  ElectronClipboard | ElectronSyncIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const clipboard = yield* ElectronClipboard;
    const ipc = yield* ElectronSyncIpc;
    const windows = yield* WindowRuntime;
    const authorize = (event: IpcMainEvent, capability: string): void => {
      requireTrustedAppRendererSender(event, capability, config.rendererUrl);
      if (!windows.has(event.sender.id)) {
        throw new Error(`${capability} requires an active Nodex window`);
      }
    };

    yield* ipc.on(CLIPBOARD_INSPECT_PASTE_SYNC_CHANNEL, (event) => {
      try {
        authorize(event, "Clipboard paste inspection");
        event.returnValue = inspectClipboardPasteItems(clipboard);
      } catch (error) {
        captureMainException(error, {
          tags: { channel: CLIPBOARD_INSPECT_PASTE_SYNC_CHANNEL, mechanism: "ipc-sync" },
          extra: { senderWebContentsId: event.sender.id },
        });
        event.returnValue = { items: [] };
      }
    });
    yield* ipc.on(MANAGED_ASSET_RESOLVE_PATH_SYNC_CHANNEL, (event, source: unknown) => {
      try {
        authorize(event, "Managed asset path access");
        if (typeof source !== "string") {
          event.returnValue = null;
          return;
        }
        const parsed = parseAssetSource(source);
        event.returnValue = parsed ? resolveAssetPath(parsed.fileName) : null;
      } catch {
        event.returnValue = null;
      }
    });
    yield* ipc.on(MANAGED_BLOB_RESOLVE_PATH_SYNC_CHANNEL, (event, contentHash: unknown) => {
      try {
        authorize(event, "Managed Blob path access");
        event.returnValue =
          typeof contentHash === "string"
            ? resolveManagedBlobPath(config.nodexHome, contentHash)
            : null;
      } catch {
        event.returnValue = null;
      }
    });
    yield* ipc.on(FILE_PATH_INSPECT_SYNC_CHANNEL, (event, value: unknown) => {
      try {
        authorize(event, "Local file inspection");
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > PRELOAD_FILE_PATH_MAX_LENGTH ||
          value.includes("\0") ||
          !isAbsolute(value)
        ) {
          event.returnValue = null;
          return;
        }
        const stats = lstatSync(value);
        if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
          event.returnValue = null;
          return;
        }
        event.returnValue = {
          path: value,
          kind: stats.isDirectory() ? "folder" : "file",
          name: basename(value),
          ...(stats.isFile() ? { bytes: stats.size } : {}),
        };
      } catch {
        event.returnValue = null;
      }
    });
  }),
);
