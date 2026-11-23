import { useState } from "react";
import { ConnectorGlobeIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";

/** The site's icon from the public favicon service, or null for anything but a web address. */
export function siteFaviconUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(url.origin)}&size=32&drop_404_icon=true`;
}

/**
 * A website's icon. A globe holds its place until the icon has loaded, and stays when the site
 * has none, so the slot never flashes empty or shows a broken image.
 */
export function SiteFavicon({
  className,
  compactGlobe = false,
  href,
  loadRemote = true,
}: {
  className?: string;
  /** Draws the placeholder globe smaller than the slot, for dense chips. */
  compactGlobe?: boolean;
  href: string;
  loadRemote?: boolean;
}) {
  const faviconUrl = loadRemote ? siteFaviconUrl(href) : null;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const loaded = faviconUrl !== null && loadedUrl === faviconUrl;
  return (
    <span aria-hidden className={cn("relative inline-block shrink-0", className)}>
      {loaded ? null : (
        <span className="absolute inset-0 flex items-center justify-center">
          <ConnectorGlobeIcon className={compactGlobe ? "size-3" : "size-full"} />
        </span>
      )}
      {faviconUrl ? (
        <img
          key={faviconUrl}
          alt=""
          className={cn(
            "absolute inset-0 size-full rounded-2xs object-contain",
            loaded ? "opacity-100" : "opacity-0",
          )}
          decoding="async"
          draggable={false}
          onLoad={() => setLoadedUrl(faviconUrl)}
          referrerPolicy="no-referrer"
          src={faviconUrl}
        />
      ) : null}
    </span>
  );
}
