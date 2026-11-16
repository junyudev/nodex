import { getIntl } from "@/lib/i18n";
import type { DatabasePropertyOption } from "../../shared/database-kernel";

export const PROPERTY_OPTION_COLOR_CLASS_NAMES: Readonly<Record<string, string>> = {
  gray: "bg-token-foreground/8 text-token-text-secondary",
  default: "bg-token-foreground/8 text-token-text-secondary",
  brown: "bg-[var(--brown-bg)] text-[var(--brown-text)]",
  orange: "bg-[var(--orange-bg)] text-[var(--orange-text)]",
  yellow: "bg-[var(--yellow-bg)] text-[var(--yellow-text)]",
  green: "bg-[var(--green-bg)] text-[var(--green-text)]",
  blue: "bg-[var(--blue-bg)] text-[var(--blue-text)]",
  purple: "bg-[var(--purple-bg)] text-[var(--purple-text)]",
  pink: "bg-[var(--pink-bg)] text-[var(--pink-text)]",
  red: "bg-[var(--red-bg)] text-[var(--red-text)]",
};

export const DATA_SOURCE_PROPERTY_OPTION_PALETTE = [
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

export const defaultDataSourcePropertyOptionColor = (identity: string): string => {
  let hash = 2_166_136_261;
  for (const character of identity) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return DATA_SOURCE_PROPERTY_OPTION_PALETTE[
    (hash >>> 0) % DATA_SOURCE_PROPERTY_OPTION_PALETTE.length
  ]!;
};

const FALLBACK_OPTION_COLOR_CLASS_NAME = "bg-token-foreground/8 text-token-text-secondary";

export const propertyOptionColorClassName = (color?: string): string => {
  if (!color) return FALLBACK_OPTION_COLOR_CLASS_NAME;
  return (
    PROPERTY_OPTION_COLOR_CLASS_NAMES[color.toLocaleLowerCase()] ?? FALLBACK_OPTION_COLOR_CLASS_NAME
  );
};

const normalizedSearchText = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase();

export const filterDataSourcePropertyOptions = (
  options: readonly DatabasePropertyOption[],
  query: string,
): readonly DatabasePropertyOption[] => {
  const normalized = normalizedSearchText(query);
  if (!normalized) return options;
  return options.filter((option) => normalizedSearchText(option.name).includes(normalized));
};

export const canCreateDataSourcePropertyOption = (
  options: readonly DatabasePropertyOption[],
  query: string,
): boolean => {
  const normalized = normalizedSearchText(query);
  if (!normalized) return false;
  return !options.some((option) => normalizedSearchText(option.name) === normalized);
};

export interface PresentedDataSourcePropertyOption {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly missing: boolean;
}

export const presentSelectedDataSourcePropertyOptions = (
  options: readonly DatabasePropertyOption[],
  selectedIds: readonly string[],
): readonly PresentedDataSourcePropertyOption[] => {
  const byId = new Map(options.map((option) => [option.id, option]));
  return selectedIds.map((id) => {
    const option = byId.get(id);
    return option
      ? { ...option, missing: false }
      : {
          id,
          name: getIntl().formatMessage({
            id: "lib.dataSourcePropertyOptions.unknownOption",
            defaultMessage: "Unknown option",
          }),
          missing: true,
        };
  });
};
