import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { WindowSessionBootstrap } from "./lib/types";
import type { AppRuntimeCapabilities } from "../shared/runtime-capabilities";
import App from "./app";
import { AppProviders } from "./app-providers";
import "./globals.css";

export async function mountApplicationRenderer({
  runtimeCapabilities,
  windowSessionBootstrap,
}: {
  readonly runtimeCapabilities: AppRuntimeCapabilities;
  readonly windowSessionBootstrap: WindowSessionBootstrap;
}): Promise<void> {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Nodex renderer root is missing");

  const Agentation = import.meta.env.DEV ? (await import("agentation")).Agentation : null;
  const root = createRoot(rootElement);
  // The renderer-ready report is a multi-window scheduling boundary, so the
  // first full application commit must precede this function's resolution.
  flushSync(() => {
    root.render(
      <StrictMode>
        <AppProviders runtimeCapabilities={runtimeCapabilities}>
          <App windowSessionBootstrap={windowSessionBootstrap} />
          {Agentation ? <Agentation /> : null}
        </AppProviders>
      </StrictMode>,
    );
  });
}
