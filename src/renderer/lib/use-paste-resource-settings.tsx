import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  readPasteResourceSettings,
  writePasteResourceSettings,
  type PasteResourceSettings,
} from "./paste-resource-settings";

interface PasteResourceSettingsContextValue {
  settings: PasteResourceSettings;
  setSettings: (value: PasteResourceSettings) => void;
  updateSettings: (patch: Partial<PasteResourceSettings>) => void;
}

const PasteResourceSettingsContext = createContext<PasteResourceSettingsContextValue>({
  settings: readPasteResourceSettings(),
  setSettings: () => {},
  updateSettings: () => {},
});

function usePasteResourceSettingsInternal(): PasteResourceSettingsContextValue {
  const [settings, setSettingsState] = useState<PasteResourceSettings>(() =>
    readPasteResourceSettings(),
  );

  const setSettings = useCallback((value: PasteResourceSettings) => {
    const next = writePasteResourceSettings(value);
    setSettingsState(next);
  }, []);

  const updateSettings = useCallback((patch: Partial<PasteResourceSettings>) => {
    setSettingsState((current) => {
      const next = writePasteResourceSettings({
        ...current,
        ...patch,
      });
      return next;
    });
  }, []);

  return { settings, setSettings, updateSettings };
}

export function PasteResourceSettingsProvider({ children }: { children: ReactNode }) {
  const value = usePasteResourceSettingsInternal();
  return (
    <PasteResourceSettingsContext.Provider value={value}>
      {children}
    </PasteResourceSettingsContext.Provider>
  );
}

export function usePasteResourceSettings(): PasteResourceSettingsContextValue {
  return useContext(PasteResourceSettingsContext);
}
