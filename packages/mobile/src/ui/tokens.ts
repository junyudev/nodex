import { useCSSVariable } from "uniwind";

/** Colors a native prop needs as a value. `global.css` stays their only definition. */
export type ColorToken =
  | "surface"
  | "surface-2"
  | "surface-3"
  | "fill"
  | "glass"
  | "ink"
  | "ink-2"
  | "ink-3"
  | "line"
  | "accent"
  | "on-accent"
  | "danger"
  | "warning"
  | "success";

export const useColor = (token: ColorToken): string => {
  const value = useCSSVariable(`--color-${token}`);
  return typeof value === "string" ? value : "#808080";
};
