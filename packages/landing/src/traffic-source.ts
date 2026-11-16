const CAMPAIGN_TOKEN = /^[a-z0-9._-]{1,64}$/i;

const siteHost = (hostname: string): string => hostname.replace(/^www\./, "").replace(/\.$/, "");

export function trafficSource(page: URL, referrer: string): string {
  for (const key of ["utm_source", "ref"]) {
    const value = page.searchParams.get(key)?.trim();
    if (value && CAMPAIGN_TOKEN.test(value)) return value.toLowerCase();
  }

  if (!referrer) return "direct";
  try {
    const url = new URL(referrer);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "direct";
    const host = siteHost(url.hostname);
    return host === siteHost(page.hostname) ? "internal" : host;
  } catch {
    return "direct";
  }
}
