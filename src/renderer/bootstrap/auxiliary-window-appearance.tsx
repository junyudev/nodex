import { useState, type ReactNode } from "react";
import { createMaitaiStore, MaitaiProvider } from "../lib/maitai";
import { ThemeProvider } from "../lib/use-theme";
import { TypographyProvider } from "../lib/use-typography-preferences";

/** Restricted windows share browser-storage appearance without the application preload. */
export function AuxiliaryWindowAppearance({ children }: { children: ReactNode }) {
  const [store] = useState(() => createMaitaiStore());
  return (
    <MaitaiProvider store={store}>
      <ThemeProvider>
        <TypographyProvider>{children}</TypographyProvider>
      </ThemeProvider>
    </MaitaiProvider>
  );
}
