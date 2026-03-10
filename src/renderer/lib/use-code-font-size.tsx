import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_CODE_FONT_SIZE,
  applyCodeFontSizeRootVariable,
  readCodeFontSize,
  writeCodeFontSize,
} from "./code-font-size";

interface CodeFontSizeContextValue {
  codeFontSize: number;
  setCodeFontSize: (value: number) => void;
}

const CodeFontSizeContext = createContext<CodeFontSizeContextValue>({
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  setCodeFontSize: () => {},
});

function useCodeFontSizeInternal(): CodeFontSizeContextValue {
  const [codeFontSize, setCodeFontSizeState] = useState(() => readCodeFontSize());

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    applyCodeFontSizeRootVariable(document.documentElement, codeFontSize);
  }, [codeFontSize]);

  const setCodeFontSize = useCallback((value: number) => {
    const normalized = writeCodeFontSize(value);
    setCodeFontSizeState(normalized);
  }, []);

  return { codeFontSize, setCodeFontSize };
}

export function CodeFontSizeProvider({ children }: { children: ReactNode }) {
  const value = useCodeFontSizeInternal();
  return (
    <CodeFontSizeContext.Provider value={value}>
      {children}
    </CodeFontSizeContext.Provider>
  );
}

export function useCodeFontSize(): CodeFontSizeContextValue {
  return useContext(CodeFontSizeContext);
}
