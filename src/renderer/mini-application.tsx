import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { MiniBootstrap } from "../shared/app-startup";
import { AppProviders } from "./app-providers";
import { initializeApplicationAppearance } from "./bootstrap/application-appearance";
import { MiniPanel } from "./features/mini/mini-panel";

export function mountMiniApplication(bootstrap: MiniBootstrap): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Mini renderer root is missing");
  initializeApplicationAppearance();
  createRoot(rootElement).render(
    <StrictMode>
      <AppProviders runtimeCapabilities={bootstrap.runtimeCapabilities} surface="mini">
        <MiniPanel />
      </AppProviders>
    </StrictMode>,
  );
}
