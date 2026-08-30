import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { NodexHoverCardProvider } from "./components/ui/hover-card";
import { NodexTooltipProvider } from "./components/ui/tooltip";
import { BrowserSidebarThemeSynchronizer } from "./features/browser-sidebar/browser-sidebar-theme-synchronizer";
import { BrowserSidebarRuntimeSynchronizer } from "./features/browser-sidebar/browser-sidebar-runtime-synchronizer";
import { CodeFontSizeProvider } from "./lib/use-code-font-size";
import { FileLinkOpenerProvider } from "./lib/use-file-link-opener";
import { SansFontSizeProvider } from "./lib/use-sans-font-size";
import { ReducedMotionProvider } from "./lib/use-reduced-motion";
import { CodexServiceTierSettingsProvider } from "./lib/use-codex-service-tier-settings";
import { CodexThreadSettingsProvider } from "./lib/use-codex-thread-settings";
import { NodexQueryProvider } from "./lib/query-client";
import { ThemeProvider } from "./lib/use-theme";
import { readAppUpdateStatus, subscribeAppUpdateStatus } from "./lib/app-update-runtime";
import type { AppUpdateStatus } from "./lib/types";
import { createMaitaiStore, MaitaiProvider, preloadEagerPersistedAtoms } from "./lib/maitai";
import { KeyboardLayoutProvider } from "./lib/keyboard-layout";
import { InAppDictationRouter } from "./features/dictation/in-app-dictation-router";
import { DevelopmentFeaturesProvider } from "./lib/development-features-context";
import {
  FAIL_CLOSED_RUNTIME_CAPABILITIES,
  type AppRuntimeCapabilities,
} from "../shared/runtime-capabilities";
import "katex/dist/katex.min.css";
import "./globals.css";

interface AppProvidersProps {
  children: ReactNode;
  runtimeCapabilities?: AppRuntimeCapabilities;
}

const AppUpdateStatusContext = createContext<AppUpdateStatus | null>(null);
const INITIAL_APP_UPDATE_STATUS: AppUpdateStatus = {
  availableVersion: null,
  checkedAt: null,
  currentVersion: "dev",
  message: "App update status is loading.",
  progressPercent: null,
  releaseDate: null,
  releaseName: null,
  releaseNotes: null,
  status: "unsupported",
  supported: false,
  totalBytes: null,
  transferredBytes: null,
  channel: "stable",
  buildDefaultChannel: "stable",
  channelChangeAllowed: false,
};

function isAppUpdateStatus(value: unknown): value is AppUpdateStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppUpdateStatus).status === "string" &&
    typeof (value as AppUpdateStatus).supported === "boolean" &&
    typeof (value as AppUpdateStatus).currentVersion === "string"
  );
}

export function AppUpdateStatusProvider({ children }: AppProvidersProps) {
  const [status, setStatus] = useState<AppUpdateStatus>(INITIAL_APP_UPDATE_STATUS);

  useEffect(() => {
    if (window.__NODEX_STORYBOOK__ === true) return;
    let cancelled = false;
    let observedPush = false;
    const unsubscribe = subscribeAppUpdateStatus((nextStatus) => {
      if (cancelled) return;
      observedPush = true;
      setStatus(nextStatus);
    });
    void readAppUpdateStatus()
      .then((snapshot) => {
        if (!cancelled && !observedPush && isAppUpdateStatus(snapshot)) setStatus(snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <AppUpdateStatusContext.Provider value={status}>{children}</AppUpdateStatusContext.Provider>
  );
}

export function useAppUpdateStatus(): AppUpdateStatus | null {
  return useContext(AppUpdateStatusContext);
}

export function AppProviders({
  children,
  runtimeCapabilities = FAIL_CLOSED_RUNTIME_CAPABILITIES,
}: AppProvidersProps) {
  return (
    <DevelopmentFeaturesProvider capabilities={runtimeCapabilities}>
      <NodexQueryProvider>
        <RendererStateProvider>
          <ThemeProvider>
            <ReducedMotionProvider>
              <AppUpdateStatusProvider>
                <KeyboardLayoutProvider>
                  <InAppDictationRouter>
                    <BrowserSidebarRuntimeSynchronizer />
                    <BrowserSidebarThemeSynchronizer />
                    <SansFontSizeProvider>
                      <CodeFontSizeProvider>
                        <FileLinkOpenerProvider>
                          <CodexServiceTierSettingsProvider>
                            <CodexThreadSettingsProvider>
                              <NodexHoverCardProvider>
                                <NodexTooltipProvider>{children}</NodexTooltipProvider>
                              </NodexHoverCardProvider>
                            </CodexThreadSettingsProvider>
                          </CodexServiceTierSettingsProvider>
                        </FileLinkOpenerProvider>
                      </CodeFontSizeProvider>
                    </SansFontSizeProvider>
                  </InAppDictationRouter>
                </KeyboardLayoutProvider>
              </AppUpdateStatusProvider>
            </ReducedMotionProvider>
          </ThemeProvider>
        </RendererStateProvider>
      </NodexQueryProvider>
    </DevelopmentFeaturesProvider>
  );
}

export function RendererStateProvider({ children }: AppProvidersProps) {
  const queryClient = useQueryClient();
  const [store] = useState(() => {
    const nextStore = createMaitaiStore({ queryClient });
    void preloadEagerPersistedAtoms(nextStore);
    return nextStore;
  });
  return <MaitaiProvider store={store}>{children}</MaitaiProvider>;
}
