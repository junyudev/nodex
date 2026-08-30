import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { DevelopmentFeatureSlug } from "../../shared/development-features";
import type { AppRuntimeCapabilities } from "../../shared/runtime-capabilities";

const DevelopmentFeaturesContext = createContext<ReadonlySet<DevelopmentFeatureSlug> | null>(null);

export function DevelopmentFeaturesProvider({
  capabilities,
  children,
}: {
  readonly capabilities: AppRuntimeCapabilities;
  readonly children: ReactNode;
}) {
  const enabled = useMemo(
    () => new Set(capabilities.enabledDevelopmentFeatures),
    [capabilities.enabledDevelopmentFeatures],
  );
  return (
    <DevelopmentFeaturesContext.Provider value={enabled}>
      {children}
    </DevelopmentFeaturesContext.Provider>
  );
}

/** Missing providers and unknown capabilities deliberately evaluate to disabled. */
export function useDevelopmentFeature(slug: DevelopmentFeatureSlug): boolean {
  return useContext(DevelopmentFeaturesContext)?.has(slug) === true;
}
