import { contextBridge, ipcRenderer } from "electron";
import type {
  AvatarOverlayRendererCommand,
  AvatarOverlayRendererEvent,
} from "../shared/avatar-overlay";

// Sandboxed Electron preloads must stay single-file bundles. Keep channel
// literals local so this restricted bridge cannot acquire the main preload's
// broad transport surface through a shared emitted chunk.
const AVATAR_OVERLAY_COMMAND_CHANNEL: typeof import("../shared/avatar-overlay").AVATAR_OVERLAY_COMMAND_CHANNEL =
  "avatar-overlay:command";
const AVATAR_OVERLAY_EVENT_CHANNEL: typeof import("../shared/avatar-overlay").AVATAR_OVERLAY_EVENT_CHANNEL =
  "avatar-overlay:event";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPoint = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const point = value as { readonly x?: unknown; readonly y?: unknown };
  return isFiniteNumber(point.x) && isFiniteNumber(point.y);
};

const isSize = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const size = value as { readonly width?: unknown; readonly height?: unknown };
  return (
    isFiniteNumber(size.width) && isFiniteNumber(size.height) && size.width > 0 && size.height > 0
  );
};

const isRect = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const rect = value as {
    readonly x?: unknown;
    readonly y?: unknown;
    readonly width?: unknown;
    readonly height?: unknown;
  };
  return isPoint(rect) && isSize(rect);
};

const isRendererCommand = (value: unknown): value is AvatarOverlayRendererCommand => {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<AvatarOverlayRendererCommand> & {
    readonly layout?: {
      readonly mascot?: unknown;
      readonly placement?: unknown;
      readonly stackDisplayHeight?: unknown;
      readonly viewport?: unknown;
    };
    readonly state?: {
      readonly currentHostID?: unknown;
      readonly stackDisplayHeight?: unknown;
    };
  };
  if (command.type === "computer-use-cursor-changed") {
    return command.point === null || isPoint(command.point);
  }
  if (command.type === "native-layout-state-changed") {
    return Boolean(
      command.state &&
      (command.state.currentHostID === null || typeof command.state.currentHostID === "string") &&
      isFiniteNumber(command.state.stackDisplayHeight),
    );
  }
  if (command.type !== "layout-changed") return false;
  const placement = command.layout?.placement;
  return Boolean(
    typeof command.isVisible === "boolean" &&
    command.layout &&
    isRect(command.layout.mascot) &&
    (placement === "top-start" ||
      placement === "top-end" ||
      placement === "bottom-start" ||
      placement === "bottom-end") &&
    isFiniteNumber(command.layout.stackDisplayHeight) &&
    isSize(command.layout.viewport),
  );
};

const isRendererEvent = (value: unknown): value is AvatarOverlayRendererEvent => {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AvatarOverlayRendererEvent> & {
    readonly mascot?: unknown;
    readonly tray?: unknown;
    readonly regions?: unknown;
  };
  if (event.type === "ready" || event.type === "close" || event.type === "hide") return true;
  if (event.type === "pointer-interaction-changed") {
    return typeof event.isInteractive === "boolean";
  }
  if (event.type === "element-size-changed") {
    return isSize(event.mascot) && (event.tray === null || isSize(event.tray));
  }
  if (event.type === "pointer-regions-changed") {
    return (
      Array.isArray(event.regions) && event.regions.length <= 64 && event.regions.every(isRect)
    );
  }
  if (event.type === "drag-start") {
    return (
      isFiniteNumber(event.pointerScreenX) &&
      isFiniteNumber(event.pointerScreenY) &&
      isFiniteNumber(event.pointerWindowX) &&
      isFiniteNumber(event.pointerWindowY)
    );
  }
  return (
    (event.type === "drag-move" || event.type === "drag-end") &&
    isFiniteNumber(event.pointerScreenX) &&
    isFiniteNumber(event.pointerScreenY)
  );
};

contextBridge.exposeInMainWorld("avatarOverlay", {
  onCommand: (callback: (command: AvatarOverlayRendererCommand) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: unknown): void => {
      if (isRendererCommand(command)) callback(command);
    };
    ipcRenderer.on(AVATAR_OVERLAY_COMMAND_CHANNEL, listener);
    return () => ipcRenderer.removeListener(AVATAR_OVERLAY_COMMAND_CHANNEL, listener);
  },
  sendEvent: (event: AvatarOverlayRendererEvent): Promise<boolean> => {
    if (!isRendererEvent(event)) {
      return Promise.reject(new TypeError("Invalid avatar overlay event"));
    }
    return ipcRenderer.invoke(AVATAR_OVERLAY_EVENT_CHANNEL, event) as Promise<boolean>;
  },
});
