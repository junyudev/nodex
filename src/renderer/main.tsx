import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";
import App from "./app";
import { TooltipProvider } from "./components/ui/tooltip";
import { CardPropertyPositionProvider } from "./lib/use-card-property-position";
import { CodeFontSizeProvider } from "./lib/use-code-font-size";
import { FileLinkOpenerProvider } from "./lib/use-file-link-opener";
import { NfmAutolinkSettingsProvider } from "./lib/use-nfm-autolink-settings";
import { PasteResourceSettingsProvider } from "./lib/use-paste-resource-settings";
import { CardStageCollapsedPropertiesProvider } from "./lib/use-card-stage-collapsed-properties";
import { SansFontSizeProvider } from "./lib/use-sans-font-size";
import { SpellcheckProvider } from "./lib/use-spellcheck";
import { ThemeProvider } from "./lib/use-theme";
import "./globals.css";

const root = document.documentElement;
const isElectronWindow = Boolean(window.api);

root.dataset.codexWindowType = isElectronWindow ? "electron" : "browser";

if (isElectronWindow) {
  const isDark = root.classList.contains("dark");
  root.classList.toggle("electron-dark", isDark);
  root.classList.toggle("electron-light", !isDark);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <SansFontSizeProvider>
        <CodeFontSizeProvider>
          <FileLinkOpenerProvider>
            <NfmAutolinkSettingsProvider>
              <PasteResourceSettingsProvider>
                <SpellcheckProvider>
                  <CardStageCollapsedPropertiesProvider>
                    <CardPropertyPositionProvider>
                      <TooltipProvider>
                        <App />
                        {process.env.NODE_ENV === "development" && <Agentation />}
                      </TooltipProvider>
                    </CardPropertyPositionProvider>
                  </CardStageCollapsedPropertiesProvider>
                </SpellcheckProvider>
              </PasteResourceSettingsProvider>
            </NfmAutolinkSettingsProvider>
          </FileLinkOpenerProvider>
        </CodeFontSizeProvider>
      </SansFontSizeProvider>
    </ThemeProvider>
  </StrictMode>
);
