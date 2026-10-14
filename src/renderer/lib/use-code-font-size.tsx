import { useTypographyPreferences } from "./use-typography-preferences";

export function useCodeFontSize() {
  const { preferences, setFontSize } = useTypographyPreferences();
  return {
    codeFontSize: preferences.codeFontSize,
    setCodeFontSize: (value: number) => setFontSize("code", value),
  };
}
