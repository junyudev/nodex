import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

interface SpellcheckContextValue {
  spellcheck: boolean;
  toggleSpellcheck: () => void;
}

const STORAGE_KEY = "nodex-spellcheck";

const SpellcheckContext = createContext<SpellcheckContextValue>({
  spellcheck: true,
  toggleSpellcheck: () => { },
});

function useSpellcheckInternal(): SpellcheckContextValue {
  const [spellcheck, setSpellcheck] = useState<boolean>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== "false";
  });

  const toggleSpellcheck = useCallback(() => {
    setSpellcheck((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
      return next;
    });
  }, []);

  return { spellcheck, toggleSpellcheck };
}

export function SpellcheckProvider({ children }: { children: ReactNode }) {
  const value = useSpellcheckInternal();
  return (
    <SpellcheckContext.Provider value={value}>
      {children}
    </SpellcheckContext.Provider>
  );
}

export function useSpellcheck(): SpellcheckContextValue {
  return useContext(SpellcheckContext);
}
