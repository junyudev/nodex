export const NODEX_DEVELOPMENT_FEATURES_ENV = "NODEX_DEV_ENABLED_FEATURES" as const;

// Keep this catalog limited to gates with a current production owner. When a
// product surface is retired, its launcher alias should disappear with it.
export const DEVELOPMENT_FEATURE_CATALOG = [
  {
    slug: "database-page-reorder-menu",
    description: "Show Database Page rank controls in the context menu.",
    defaultEnabled: false,
  },
  {
    slug: "runtime-metrics",
    description: "Emit structured development runtime metrics.",
    defaultEnabled: false,
  },
] as const;

export type DevelopmentFeatureSlug = (typeof DEVELOPMENT_FEATURE_CATALOG)[number]["slug"];

const featureBySlug = new Map<string, (typeof DEVELOPMENT_FEATURE_CATALOG)[number]>(
  DEVELOPMENT_FEATURE_CATALOG.map((feature) => [feature.slug, feature]),
);

export const listDevelopmentFeatureSlugs = (): readonly DevelopmentFeatureSlug[] =>
  DEVELOPMENT_FEATURE_CATALOG.map((feature) => feature.slug);

export const resolveDevelopmentFeatureOverrides = (
  values: readonly string[],
): readonly DevelopmentFeatureSlug[] => {
  const normalized = [...new Set(values.map((value) => value.trim()))]
    .filter((value) => value.length > 0)
    .sort();
  const unknown = normalized.filter((value) => !featureBySlug.has(value));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown development feature ${unknown.join(", ")}. Available features: ${listDevelopmentFeatureSlugs().join(", ")}`,
    );
  }
  return normalized as DevelopmentFeatureSlug[];
};

export const parseDevelopmentFeatureEnvironment = (
  environment: NodeJS.ProcessEnv,
): ReadonlySet<DevelopmentFeatureSlug> => {
  const configured = environment[NODEX_DEVELOPMENT_FEATURES_ENV]?.trim();
  if (!configured) return new Set();
  return new Set(resolveDevelopmentFeatureOverrides(configured.split(",")));
};

export const isDevelopmentFeatureEnabled = (
  slug: DevelopmentFeatureSlug,
  environment: NodeJS.ProcessEnv = process.env,
): boolean => {
  const feature = featureBySlug.get(slug);
  if (!feature) return false;
  return feature.defaultEnabled || parseDevelopmentFeatureEnvironment(environment).has(slug);
};

export const developmentFeatureEnvironment = (
  enabled: readonly DevelopmentFeatureSlug[],
): NodeJS.ProcessEnv =>
  enabled.length === 0 ? {} : { [NODEX_DEVELOPMENT_FEATURES_ENV]: enabled.join(",") };
