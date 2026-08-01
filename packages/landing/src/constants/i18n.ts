const UI_EN = (await import("~/i18n/en/translation.json", { with: { type: "json" } })).default;

export const i18n = {
  DEFAULT_LOCALE: "en",
  LOCALES: [{ label: "English", value: "en", ui: UI_EN, intl: "en-US" }],
};

/**
 * Type definition for UI translations based on the English translation
 */
export type UIProps = typeof UI_EN;

export const getIntlLocale = (locale: string) => {
  return i18n.LOCALES.find((l) => l.value === locale)?.intl;
};
