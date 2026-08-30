import type { DevelopmentFeatureSlug } from "./development-features";

export interface AppRuntimeCapabilities {
  readonly enabledDevelopmentFeatures: readonly DevelopmentFeatureSlug[];
}

export const FAIL_CLOSED_RUNTIME_CAPABILITIES: AppRuntimeCapabilities = {
  enabledDevelopmentFeatures: [],
};
