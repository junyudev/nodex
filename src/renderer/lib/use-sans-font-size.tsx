import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_SANS_FONT_SIZE,
  applySansFontSizeRootVariables,
  readSansFontSize,
  writeSansFontSize,
} from "./sans-font-size";

interface SansFontSizeContextValue {
  sansFontSize: number;
  setSansFontSize: (value: number) => void;
}

const SansFontSizeContext = createContext<SansFontSizeContextValue>({
  sansFontSize: DEFAULT_SANS_FONT_SIZE,
  setSansFontSize: () => {},
});

function useSansFontSizeInternal(): SansFontSizeContextValue {
  const [sansFontSize, setSansFontSizeState] = useState(() => readSansFontSize());

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    applySansFontSizeRootVariables(document.documentElement, sansFontSize);
  }, [sansFontSize]);

  const setSansFontSize = useCallback((value: number) => {
    const normalized = writeSansFontSize(value);
    setSansFontSizeState(normalized);
  }, []);

  return { sansFontSize, setSansFontSize };
}

export function SansFontSizeProvider({ children }: { children: ReactNode }) {
  const value = useSansFontSizeInternal();
  return (
    <SansFontSizeContext.Provider value={value}>
      {children}
    </SansFontSizeContext.Provider>
  );
}

export function useSansFontSize(): SansFontSizeContextValue {
  return useContext(SansFontSizeContext);
}
