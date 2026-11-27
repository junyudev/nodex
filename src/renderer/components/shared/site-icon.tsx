import { useQuery } from "@tanstack/react-query";
import { useState, type ComponentType, type SVGProps } from "react";
import { ConnectorGlobeIcon } from "@/components/shared/icons";
import {
  WebsiteFigmaIcon,
  WebsiteGitHubIcon,
  WebsiteGmailIcon,
  WebsiteGoogleCalendarIcon,
  WebsiteGoogleDriveIcon,
  WebsiteLinearIcon,
  WebsiteNotionIcon,
  WebsiteSalesforceIcon,
  WebsiteSlackIcon,
} from "@/components/shared/icons/website-icons";
import { linkFaviconQueryOptions, readFaviconInk, type FaviconInk } from "@/lib/link-favicons";
import { cn } from "@/lib/utils";
import type { BrowserWebsiteSourceIconId } from "../../../shared/browser-website-source";
import { resolveLinkSite } from "../../../shared/link-site";

/** Sites Nodex draws itself: no request leaves the device for them. */
export const WEBSITE_GLYPHS: Record<
  BrowserWebsiteSourceIconId,
  ComponentType<SVGProps<SVGSVGElement>>
> = {
  figma: WebsiteFigmaIcon,
  github: WebsiteGitHubIcon,
  gmail: WebsiteGmailIcon,
  googleCalendar: WebsiteGoogleCalendarIcon,
  googleDrive: WebsiteGoogleDriveIcon,
  linear: WebsiteLinearIcon,
  notion: WebsiteNotionIcon,
  salesforce: WebsiteSalesforceIcon,
  slack: WebsiteSlackIcon,
};

interface SiteIconProps {
  readonly href: string;
  /** Sizes the slot; the icon fills it. */
  readonly className?: string;
  /** Draws the placeholder globe smaller than the slot, for dense chips. */
  readonly compactGlobe?: boolean;
}

function Globe({ compact }: { readonly compact: boolean }) {
  return (
    <span className="absolute inset-0 flex items-center justify-center">
      <ConnectorGlobeIcon className={compact ? "size-3" : "size-full"} />
    </span>
  );
}

/**
 * Where a web link goes, at a glance: Nodex's own artwork for sites it knows, the site's favicon
 * for other public sites, and a globe for everything else, including this device and private
 * networks, whose names never leave it. A globe holds the slot while a favicon loads, so the slot
 * never flashes empty or shows a broken image.
 */
export function SiteIcon({ href, className, compactGlobe = false }: SiteIconProps) {
  const site = resolveLinkSite(href);
  // Unselectable, so a copied link carries its words and address without the icon.
  const slot = cn("relative inline-block shrink-0 select-none", className);
  if (site?.kind === "glyph") {
    const Glyph = WEBSITE_GLYPHS[site.glyph];
    return (
      <span aria-hidden className={slot} data-site-icon="glyph">
        <Glyph className="absolute inset-0 size-full" />
      </span>
    );
  }
  if (site?.kind === "favicon")
    return <FaviconIcon host={site.host} className={slot} compactGlobe={compactGlobe} />;
  return (
    <span aria-hidden className={slot} data-site-icon="globe">
      <Globe compact={compactGlobe} />
    </span>
  );
}

function FaviconIcon({
  host,
  className,
  compactGlobe,
}: {
  readonly host: string;
  readonly className: string;
  readonly compactGlobe: boolean;
}) {
  const { data } = useQuery(linkFaviconQueryOptions(host));
  const source = data?.status === "ready" ? data.dataUrl : null;
  const [loaded, setLoaded] = useState<{ source: string; ink: FaviconInk | null } | null>(null);
  const shown = source !== null && loaded?.source === source;
  const ink = shown ? loaded?.ink : null;
  return (
    <span aria-hidden className={className} data-site-icon={shown ? "favicon" : "globe"}>
      {shown ? null : <Globe compact={compactGlobe} />}
      {source ? (
        <img
          key={source}
          alt=""
          src={source}
          decoding="async"
          draggable={false}
          onLoad={(event) => setLoaded({ source, ink: readFaviconInk(event.currentTarget) })}
          className={cn(
            "absolute inset-0 size-full rounded-[2px] object-contain",
            shown ? "opacity-100" : "opacity-0",
            // A see-through icon drawn in the background's own tone sits on a plate of the other.
            ink === "dark" && "dark:rounded-[3px] dark:bg-token-foreground/90 dark:p-px",
            ink === "light" &&
              "rounded-[3px] bg-token-foreground/85 p-px dark:bg-transparent dark:p-0",
          )}
        />
      ) : null}
    </span>
  );
}
