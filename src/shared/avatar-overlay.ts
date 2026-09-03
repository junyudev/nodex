import type {
  RemoteHostedPipHostLayout,
  RemoteHostedPipPoint,
  RemoteHostedPipViewportRect,
} from "./remote-hosted-pip";

export const AVATAR_OVERLAY_ROUTE = "/avatar-overlay";
export const AVATAR_OVERLAY_HOST_ID = "avatar-overlay";
export const AVATAR_OVERLAY_COMMAND_CHANNEL = "avatar-overlay:command";
export const AVATAR_OVERLAY_EVENT_CHANNEL = "avatar-overlay:event";
export const AVATAR_OVERLAY_TOGGLE_CHANNEL = "avatar-overlay:toggle";
export const AVATAR_OVERLAY_WAKE_CHANNEL = "avatar-overlay:wake";

export type AvatarOverlayPlacement = "top-start" | "top-end" | "bottom-start" | "bottom-end";

export interface AvatarOverlayElementSize {
  readonly width: number;
  readonly height: number;
}

export interface AvatarOverlayLayout {
  readonly mascot: RemoteHostedPipViewportRect;
  readonly placement: AvatarOverlayPlacement;
  readonly stackDisplayHeight: number;
  readonly viewport: AvatarOverlayElementSize;
}

export interface AvatarOverlayNativeLayoutState {
  readonly currentHostID: string | null;
  readonly stackDisplayHeight: number;
}

export type AvatarOverlayRendererCommand =
  | {
      readonly type: "layout-changed";
      readonly isVisible: boolean;
      readonly layout: AvatarOverlayLayout;
    }
  | {
      readonly type: "native-layout-state-changed";
      readonly state: AvatarOverlayNativeLayoutState;
    }
  | {
      readonly type: "computer-use-cursor-changed";
      readonly point: RemoteHostedPipPoint | null;
    };

export type AvatarOverlayRendererEvent =
  | { readonly type: "ready" }
  | { readonly type: "close" }
  | { readonly type: "hide" }
  | {
      readonly type: "element-size-changed";
      readonly mascot: AvatarOverlayElementSize;
      readonly tray: AvatarOverlayElementSize | null;
    }
  | {
      readonly type: "pointer-regions-changed";
      readonly regions: readonly RemoteHostedPipViewportRect[];
    }
  | {
      readonly type: "pointer-interaction-changed";
      readonly isInteractive: boolean;
    }
  | {
      readonly type: "drag-start";
      readonly pointerScreenX: number;
      readonly pointerScreenY: number;
      readonly pointerWindowX: number;
      readonly pointerWindowY: number;
    }
  | {
      readonly type: "drag-move" | "drag-end";
      readonly pointerScreenX: number;
      readonly pointerScreenY: number;
    };

export interface AvatarOverlayHostProjection {
  readonly layout: RemoteHostedPipHostLayout;
  readonly webContentsId: number;
}
