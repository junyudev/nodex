import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  readNfmAutolinkSettings,
  writeNfmAutolinkSettings,
  type NfmAutolinkSettings,
} from "./nfm-autolink-settings";

interface NfmAutolinkSettingsContextValue {
  settings: NfmAutolinkSettings;
  setSettings: (value: NfmAutolinkSettings) => void;
  updateSettings: (patch: Partial<NfmAutolinkSettings>) => void;
}

const NfmAutolinkSettingsContext = createContext<NfmAutolinkSettingsContextValue>({
  settings: readNfmAutolinkSettings(),
  setSettings: () => {},
  updateSettings: () => {},
});

function useNfmAutolinkSettingsInternal(): NfmAutolinkSettingsContextValue {
  const [settings, setSettingsState] = useState<NfmAutolinkSettings>(() =>
    readNfmAutolinkSettings(),
  );

  const setSettings = useCallback((value: NfmAutolinkSettings) => {
    const next = writeNfmAutolinkSettings(value);
    setSettingsState(next);
  }, []);

  const updateSettings = useCallback((patch: Partial<NfmAutolinkSettings>) => {
    setSettingsState((current) => {
      const next = writeNfmAutolinkSettings({
        ...current,
        ...patch,
      });
      return next;
    });
  }, []);

  return { settings, setSettings, updateSettings };
}

export function NfmAutolinkSettingsProvider({ children }: { children: ReactNode }) {
  const value = useNfmAutolinkSettingsInternal();
  return (
    <NfmAutolinkSettingsContext.Provider value={value}>
      {children}
    </NfmAutolinkSettingsContext.Provider>
  );
}

export function useNfmAutolinkSettings(): NfmAutolinkSettingsContextValue {
  return useContext(NfmAutolinkSettingsContext);
}
