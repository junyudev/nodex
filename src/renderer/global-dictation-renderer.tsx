import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuxiliaryWindowAppearance } from "./bootstrap/auxiliary-window-appearance";
import { GlobalDictationRoot } from "./features/dictation/global-dictation-page";
import "./globals.css";

export function mountGlobalDictationRenderer(): void {
  if (!window.globalDictation) {
    throw new Error("Global dictation requires its restricted Electron preload bridge");
  }
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Global dictation renderer root is missing");
  createRoot(rootElement).render(
    <StrictMode>
      <AuxiliaryWindowAppearance>
        <GlobalDictationRoot />
      </AuxiliaryWindowAppearance>
    </StrictMode>,
  );
}
