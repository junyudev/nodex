import { useCallback, useMemo, useState, type CSSProperties } from "react";
import {
  getDevStoryFontSizeCssVariables,
  readDevStoryCodeFontSize,
  readDevStorySansFontSize,
  writeDevStoryCodeFontSize,
  writeDevStorySansFontSize,
} from "./dev-story-font-size";

interface DevStoryFontSizeState {
  sansFontSize: number;
  codeFontSize: number;
  setSansFontSize: (value: number) => void;
  setCodeFontSize: (value: number) => void;
  fontSizeVariables: CSSProperties;
}

export function useDevStoryFontSize(): DevStoryFontSizeState {
  const [sansFontSize, setSansFontSizeState] = useState(() => readDevStorySansFontSize());
  const [codeFontSize, setCodeFontSizeState] = useState(() => readDevStoryCodeFontSize());

  const setSansFontSize = useCallback((value: number) => {
    setSansFontSizeState(writeDevStorySansFontSize(value));
  }, []);

  const setCodeFontSize = useCallback((value: number) => {
    setCodeFontSizeState(writeDevStoryCodeFontSize(value));
  }, []);

  const fontSizeVariables = useMemo(
    () => getDevStoryFontSizeCssVariables({ sansFontSize, codeFontSize }) as unknown as CSSProperties,
    [sansFontSize, codeFontSize],
  );

  return {
    sansFontSize,
    codeFontSize,
    setSansFontSize,
    setCodeFontSize,
    fontSizeVariables,
  };
}
