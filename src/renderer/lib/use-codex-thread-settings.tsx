import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  readCodexThreadSettings,
  resolveCodexThreadDetailLevel,
  writeCodexThreadSettings,
} from "./codex-thread-settings";
import type { CodexThreadDetailLevel, CodexThreadSettings } from "./types";
import { updateCodexDeveloperSettings } from "./codex-thread-settings-runtime";

interface CodexThreadSettingsContextValue {
  settings: CodexThreadSettings;
  setSettings: (value: CodexThreadSettings) => void;
  updateSettings: (patch: Partial<CodexThreadSettings>) => void;
  setThreadDetailLevel: (detailLevel: CodexThreadDetailLevel) => void;
}

const DEFAULT_CONTEXT_VALUE: CodexThreadSettingsContextValue = {
  settings: readCodexThreadSettings() ?? {},
  setSettings: () => {},
  updateSettings: () => {},
  setThreadDetailLevel: () => {},
};

const CodexThreadSettingsContext =
  createContext<CodexThreadSettingsContextValue>(DEFAULT_CONTEXT_VALUE);

function useCodexThreadSettingsInternal(): CodexThreadSettingsContextValue {
  const [settings, setSettingsState] = useState<CodexThreadSettings>(
    () => readCodexThreadSettings() ?? {},
  );

  useEffect(() => {
    void updateCodexDeveloperSettings(resolveCodexThreadDetailLevel(settings.detailLevel)).catch(
      () => undefined,
    );
  }, [settings.detailLevel]);

  const setSettings = useCallback((value: CodexThreadSettings) => {
    const next = { ...value };
    writeCodexThreadSettings(next);
    setSettingsState(next);
  }, []);

  const updateSettings = useCallback((patch: Partial<CodexThreadSettings>) => {
    setSettingsState((current) => {
      const next = {
        ...current,
        ...patch,
      };
      writeCodexThreadSettings(next);
      return next;
    });
  }, []);

  const setThreadDetailLevel = useCallback(
    (detailLevel: CodexThreadDetailLevel) => {
      updateSettings({ detailLevel });
    },
    [updateSettings],
  );

  return {
    settings,
    setSettings,
    updateSettings,
    setThreadDetailLevel,
  };
}

export function CodexThreadSettingsProvider({ children }: { children: ReactNode }) {
  const value = useCodexThreadSettingsInternal();
  return (
    <CodexThreadSettingsContext.Provider value={value}>
      {children}
    </CodexThreadSettingsContext.Provider>
  );
}

export function useCodexThreadSettings(): CodexThreadSettingsContextValue {
  return useContext(CodexThreadSettingsContext);
}
