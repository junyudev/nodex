import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AvatarOverlayRoot } from "./features/avatar-overlay/avatar-overlay-page";
import "./globals.css";

export function mountAvatarOverlayRenderer(): void {
  if (!window.avatarOverlay) {
    throw new Error("Avatar overlay requires its restricted Electron preload bridge");
  }
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Avatar overlay renderer root is missing");
  createRoot(rootElement).render(
    <StrictMode>
      <AvatarOverlayRoot />
    </StrictMode>,
  );
}
