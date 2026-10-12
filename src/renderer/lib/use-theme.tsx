import { useCallback, useEffect, useLayoutEffect, type ReactNode } from "react";
import { applyCodexThemeVariant, type CodexAccent } from "./codex-theme-variant";
import {
  ACCENT_COLOR_STORAGE_KEY,
  THEME_STORAGE_KEY,
  readAccentColorPreferences,
  readThemePreference,
  resolveAccentColorPreference,
  updateAccentColorPreference,
  writeAccentColorPreferences,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme-preferences";
import {
  appScope,
  atomWithExternalStore,
  scopedAtomWithInitializer,
  scopedDerivedAtom,
  useScopedAtom,
  useScopedAtomValue,
} from "./maitai";

interface ThemeContextValue {
  theme: ThemePreference;
  resolved: ResolvedTheme;
  accent: CodexAccent;
  setTheme: (theme: ThemePreference) => void;
  setAccent: (accent: CodexAccent) => void;
}

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

const themePreferenceAtom = scopedAtomWithInitializer(appScope, readThemePreference, {
  debugLabel: "theme-preference",
});

const accentColorPreferenceAtom = scopedAtomWithInitializer(appScope, readAccentColorPreferences, {
  debugLabel: "accent-color-preference",
});

const systemDarkAtom = atomWithExternalStore(appScope, {
  debugLabel: "system-dark-preference",
  getSnapshot: () => window.matchMedia(MEDIA_QUERY).matches,
  subscribe: (listener) => {
    const mediaQuery = window.matchMedia(MEDIA_QUERY);
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  },
});

const resolvedThemeAtom = scopedDerivedAtom(
  appScope,
  (get): ResolvedTheme => {
    const theme = get(themePreferenceAtom);
    if (theme !== "system") return theme;
    return get(systemDarkAtom) ? "dark" : "light";
  },
  { debugLabel: "resolved-theme" },
);

const resolvedAccentAtom = scopedDerivedAtom(
  appScope,
  (get) => resolveAccentColorPreference(get(accentColorPreferenceAtom), get(resolvedThemeAtom)),
  { debugLabel: "resolved-accent-color" },
);

function syncDocumentThemeClasses(resolved: ResolvedTheme, accent: CodexAccent): void {
  const root = document.documentElement;
  const isDark = resolved === "dark";

  root.classList.toggle("dark", isDark);
  applyCodexThemeVariant(root, resolved, document.body, accent);

  if (root.dataset.codexWindowType !== "electron") return;

  root.classList.toggle("electron-dark", isDark);
  root.classList.toggle("electron-light", !isDark);
}

function useThemeInternal(): ThemeContextValue {
  const [theme, setThemeState] = useScopedAtom(themePreferenceAtom);
  const [, setAccentPreferences] = useScopedAtom(accentColorPreferenceAtom);
  const resolved = useScopedAtomValue(resolvedThemeAtom);
  const accent = useScopedAtomValue(resolvedAccentAtom);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setThemeState(writeThemePreference(next));
    },
    [setThemeState],
  );

  const setAccent = useCallback(
    (next: CodexAccent) => {
      setAccentPreferences((previous) =>
        writeAccentColorPreferences(
          updateAccentColorPreference(readAccentColorPreferences(previous), resolved, next),
        ),
      );
    },
    [resolved, setAccentPreferences],
  );

  return { theme, resolved, accent, setTheme, setAccent };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const value = useThemeInternal();
  const [, setThemeState] = useScopedAtom(themePreferenceAtom);
  const [, setAccentPreferences] = useScopedAtom(accentColorPreferenceAtom);
  useLayoutEffect(() => {
    syncDocumentThemeClasses(value.resolved, value.accent);
  }, [value.resolved, value.accent]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === THEME_STORAGE_KEY) {
        setThemeState(readThemePreference());
      }
      if (event.key === null || event.key === ACCENT_COLOR_STORAGE_KEY) {
        setAccentPreferences(readAccentColorPreferences());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setAccentPreferences, setThemeState]);
  return children;
}

export function useTheme(): ThemeContextValue {
  return useThemeInternal();
}
