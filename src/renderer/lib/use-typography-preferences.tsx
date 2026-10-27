import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { appScope, scopedAtomWithInitializer, useScopedAtom } from "./maitai";
import { useTheme } from "./use-theme";
import {
  TYPOGRAPHY_STORAGE_KEY,
  applyTypographyPreferences,
  normalizeFontFamily,
  normalizeFontSize,
  readTypographyPreferences,
  writeTypographyPreferences,
  type FontFamilyRole,
  type FontSizeRole,
} from "./typography-preferences";
import type { ResolvedTheme } from "./theme-preferences";

const typographyPreferencesAtom = scopedAtomWithInitializer(appScope, readTypographyPreferences, {
  debugLabel: "typography-preferences",
});

export function useTypographyPreferences() {
  const [preferences, setPreferences] = useScopedAtom(typographyPreferencesAtom);
  const setFontSmoothing = (value: boolean) => {
    setPreferences((current) =>
      writeTypographyPreferences({
        ...readTypographyPreferences(current),
        useFontSmoothing: value,
      }),
    );
  };
  const setFontSize = (role: FontSizeRole, value: number) => {
    setPreferences((current) =>
      writeTypographyPreferences({
        ...readTypographyPreferences(current),
        [`${role}FontSize`]: normalizeFontSize(role, value),
      }),
    );
  };
  const setFontFamily = (variant: ResolvedTheme, role: FontFamilyRole, value: string | null) => {
    setPreferences((current) => {
      const stored = readTypographyPreferences(current);
      return writeTypographyPreferences({
        ...stored,
        fonts: {
          ...stored.fonts,
          [variant]: { ...stored.fonts[variant], [role]: normalizeFontFamily(value) },
        },
      });
    });
  };
  return { preferences, setFontSmoothing, setFontSize, setFontFamily };
}

export function TypographyProvider({ children }: { children: ReactNode }) {
  const { preferences } = useTypographyPreferences();
  const [, setPreferences] = useScopedAtom(typographyPreferencesAtom);
  const { resolved } = useTheme();
  useLayoutEffect(() => {
    applyTypographyPreferences(document.documentElement, document.body, preferences, resolved);
  }, [preferences, resolved]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== TYPOGRAPHY_STORAGE_KEY) return;
      setPreferences(readTypographyPreferences());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setPreferences]);
  return children;
}
