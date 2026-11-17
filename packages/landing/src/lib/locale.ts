export type Locale = "en" | "zh-CN";
export type LocalizedPage = "home" | "download";

const paths: Record<LocalizedPage, Record<Locale, string>> = {
  home: { en: "/", "zh-CN": "/zh-cn/" },
  download: { en: "/download/", "zh-CN": "/zh-cn/download/" },
};

export const localizedPath = (page: LocalizedPage, locale: Locale): string => paths[page][locale];

export const alternateLocale = (locale: Locale): Locale => (locale === "en" ? "zh-CN" : "en");

/** Build each fixture once, with translations beside their English counterparts. */
export function byLocale<T>(build: (locale: Locale) => T): Record<Locale, T> {
  return { en: build("en"), "zh-CN": build("zh-CN") };
}

export function localizer(locale: Locale) {
  return (en: string, zh: string): string => (locale === "zh-CN" ? zh : en);
}
