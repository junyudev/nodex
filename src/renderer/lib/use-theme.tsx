import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark" | "system";
type Resolved = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  resolved: Resolved;
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = "nodex-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolved: "light",
  setTheme: () => { },
});

function syncDocumentThemeClasses(resolved: Resolved): void {
  const root = document.documentElement;
  const isDark = resolved === "dark";

  root.classList.toggle("dark", isDark);

  if (root.dataset.codexWindowType !== "electron") return;

  root.classList.toggle("electron-dark", isDark);
  root.classList.toggle("electron-light", !isDark);
}

function useThemeInternal(): ThemeContextValue {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system")
      return stored;
    return "system";
  });

  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia(MEDIA_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(MEDIA_QUERY);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const resolved: Resolved =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useLayoutEffect(() => {
    syncDocumentThemeClasses(resolved);
  }, [resolved]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  return { theme, resolved, setTheme };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const value = useThemeInternal();
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
