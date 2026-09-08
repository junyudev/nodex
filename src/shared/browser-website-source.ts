const WEBSITE_SOURCES = [
  { id: "googleCalendar", hostnames: ["calendar.google.com"] },
  {
    id: "googleDrive",
    hostnames: ["docs.google.com", "drive.google.com", "sheets.google.com", "slides.google.com"],
  },
  { id: "figma", hostnames: ["figma.com"] },
  { id: "github", hostnames: ["github.com"] },
  { id: "linear", hostnames: ["linear.app"] },
  { id: "gmail", hostnames: ["mail.google.com"] },
  { id: "notion", hostnames: ["app.notion.com", "notion.so"] },
  { id: "salesforce", hostnames: ["force.com", "salesforce.com"] },
  { id: "slack", hostnames: ["slack.com"] },
] as const;

export type BrowserWebsiteSourceIconId = (typeof WEBSITE_SOURCES)[number]["id"];

export function resolveBrowserWebsiteSourceIconId(href: string): BrowserWebsiteSourceIconId | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname.toLowerCase();
  return (
    WEBSITE_SOURCES.find((source) =>
      source.hostnames.some(
        (candidate) => hostname === candidate || hostname.endsWith(`.${candidate}`),
      ),
    )?.id ?? null
  );
}
