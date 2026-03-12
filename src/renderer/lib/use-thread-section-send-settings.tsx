import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  readThreadSectionSendSettings,
  writeThreadSectionConfirmBeforeSend,
  writeThreadSectionSendSettings,
  type ThreadSectionSendSettings,
} from "./thread-section-send-settings";

interface ThreadSectionSendSettingsContextValue {
  settings: ThreadSectionSendSettings;
  setSettings: (value: ThreadSectionSendSettings) => void;
  updateSettings: (patch: Partial<ThreadSectionSendSettings>) => void;
}

const ThreadSectionSendSettingsContext = createContext<ThreadSectionSendSettingsContextValue>({
  settings: readThreadSectionSendSettings(),
  setSettings: () => {},
  updateSettings: () => {},
});

function useThreadSectionSendSettingsInternal(): ThreadSectionSendSettingsContextValue {
  const [settings, setSettingsState] = useState<ThreadSectionSendSettings>(() =>
    readThreadSectionSendSettings(),
  );

  const setSettings = useCallback((value: ThreadSectionSendSettings) => {
    const next = writeThreadSectionSendSettings(value);
    setSettingsState(next);
  }, []);

  const updateSettings = useCallback((patch: Partial<ThreadSectionSendSettings>) => {
    setSettingsState((current) => {
      if (Object.keys(patch).length === 1 && typeof patch.confirmBeforeSend !== "undefined") {
        return writeThreadSectionConfirmBeforeSend(patch.confirmBeforeSend);
      }

      const next = writeThreadSectionSendSettings({
        ...current,
        ...patch,
      });
      return next;
    });
  }, []);

  return { settings, setSettings, updateSettings };
}

export function ThreadSectionSendSettingsProvider({ children }: { children: ReactNode }) {
  const value = useThreadSectionSendSettingsInternal();
  return (
    <ThreadSectionSendSettingsContext.Provider value={value}>
      {children}
    </ThreadSectionSendSettingsContext.Provider>
  );
}

export function useThreadSectionSendSettings(): ThreadSectionSendSettingsContextValue {
  return useContext(ThreadSectionSendSettingsContext);
}
