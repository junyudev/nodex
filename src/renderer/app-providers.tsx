import { type ReactNode } from "react";
import { TooltipProvider } from "./components/ui/tooltip";
import { CardPropertyPositionProvider } from "./lib/use-card-property-position";
import { CodeFontSizeProvider } from "./lib/use-code-font-size";
import { FileLinkOpenerProvider } from "./lib/use-file-link-opener";
import { NfmAutolinkSettingsProvider } from "./lib/use-nfm-autolink-settings";
import { PasteResourceSettingsProvider } from "./lib/use-paste-resource-settings";
import { CardStageCollapsedPropertiesProvider } from "./lib/use-card-stage-collapsed-properties";
import { SansFontSizeProvider } from "./lib/use-sans-font-size";
import { SpellcheckProvider } from "./lib/use-spellcheck";
import { ThreadSectionSendSettingsProvider } from "./lib/use-thread-section-send-settings";
import { ThemeProvider } from "./lib/use-theme";
import "./globals.css";

interface RendererDocumentOptions {
  storybook?: boolean;
}

interface AppProvidersProps {
  children: ReactNode;
}

declare global {
  interface Window {
    __NODEX_STORYBOOK__?: boolean;
  }
}

export function initializeRendererDocument(options?: RendererDocumentOptions): void {
  const root = document.documentElement;
  const isElectronWindow = Boolean(window.api);

  root.dataset.codexWindowType = isElectronWindow ? "electron" : "browser";
  window.__NODEX_STORYBOOK__ = options?.storybook === true;

  if (!isElectronWindow) {
    root.classList.remove("electron-dark", "electron-light");
    return;
  }

  const isDark = root.classList.contains("dark");
  root.classList.toggle("electron-dark", isDark);
  root.classList.toggle("electron-light", !isDark);
}

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <ThemeProvider>
      <SansFontSizeProvider>
        <CodeFontSizeProvider>
          <FileLinkOpenerProvider>
            <NfmAutolinkSettingsProvider>
              <PasteResourceSettingsProvider>
                <SpellcheckProvider>
                  <ThreadSectionSendSettingsProvider>
                    <CardStageCollapsedPropertiesProvider>
                      <CardPropertyPositionProvider>
                        <TooltipProvider>
                          {children}
                        </TooltipProvider>
                      </CardPropertyPositionProvider>
                    </CardStageCollapsedPropertiesProvider>
                  </ThreadSectionSendSettingsProvider>
                </SpellcheckProvider>
              </PasteResourceSettingsProvider>
            </NfmAutolinkSettingsProvider>
          </FileLinkOpenerProvider>
        </CodeFontSizeProvider>
      </SansFontSizeProvider>
    </ThemeProvider>
  );
}
