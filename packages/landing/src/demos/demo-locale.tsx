import { createContext, useContext, type ReactNode } from "react";
import type { Locale } from "../lib/locale";
import { lumen } from "./lumen";

const DemoLocale = createContext<Locale>("en");

export interface DemoProps {
  readonly locale: Locale;
}

export function DemoLocaleProvider({
  locale,
  children,
}: DemoProps & { readonly children: ReactNode }) {
  return <DemoLocale value={locale}>{children}</DemoLocale>;
}

export function useDemoLocale(): Locale {
  return useContext(DemoLocale);
}

export function useLumen() {
  return lumen[useDemoLocale()];
}
