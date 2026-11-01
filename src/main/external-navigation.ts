import { isExternallyOpenableUrl } from "../shared/browser-url-policy";

/** Validates explicit external opens at the native shell boundary. */
export function parseExternalNavigationUrl(value: string): URL {
  if (!isExternallyOpenableUrl(value)) throw new Error("This URL cannot be opened externally");
  return new URL(value);
}
