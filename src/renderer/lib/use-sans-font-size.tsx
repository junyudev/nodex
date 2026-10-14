import { useTypographyPreferences } from "./use-typography-preferences";

export function useSansFontSize() {
  const { preferences, setFontSize } = useTypographyPreferences();
  return {
    sansFontSize: preferences.uiFontSize,
    setSansFontSize: (value: number) => setFontSize("ui", value),
  };
}
