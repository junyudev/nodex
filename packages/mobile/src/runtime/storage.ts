import type { MobilePlatform } from "./platform";

export function readStored<T>(
  storage: Pick<MobilePlatform["storage"], "get">,
  key: string,
  fallback: T,
): T {
  const value = storage.get(key);
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
