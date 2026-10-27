import { useState, type ReactNode } from "react";
import { PluginsIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import type { PluginRow } from "../plugin-management";

export interface PluginLogoSource {
  readonly logoUrl: string | null;
  readonly logoDarkUrl: string | null;
  readonly name: string;
}

export function pluginLogoSource(row: PluginRow): PluginLogoSource {
  return {
    logoUrl: row.logoUrl ?? row.logoDarkUrl ?? row.composerIconUrl,
    logoDarkUrl: row.logoDarkUrl,
    name: row.summary.interface?.displayName ?? row.summary.name,
  };
}

/**
 * A plugin's logo, swapping to its dark artwork in dark appearance. A missing or broken
 * image falls back to the plugin glyph.
 */
export function PluginLogoImage({
  source,
  className,
  fallback,
}: {
  readonly source: PluginLogoSource;
  readonly className?: string;
  /** Shown instead of the plugin glyph when there is no usable image. */
  readonly fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const light = source.logoUrl;
  const dark = source.logoDarkUrl && source.logoDarkUrl !== light ? source.logoDarkUrl : null;
  if (!light || failed === light) {
    return fallback ?? <PluginsIcon aria-hidden className={cn("text-secondary", className)} />;
  }
  return (
    <>
      {dark ? (
        <img
          src={dark}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className={cn("hidden object-contain dark:block", className)}
        />
      ) : null}
      <img
        src={light}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        className={cn("object-contain", dark && "dark:hidden", className)}
        onError={() => setFailed(light)}
      />
    </>
  );
}

/** The 36px bordered tile that frames a plugin logo in directory rows. */
export function PluginLogoTile({
  source,
  className,
}: {
  readonly source: PluginLogoSource;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-default bg-surface",
        className,
      )}
    >
      <PluginLogoImage source={source} className="h-full w-full rounded-2xs" />
    </span>
  );
}
