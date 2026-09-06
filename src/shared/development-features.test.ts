import { describe, expect, test } from "vite-plus/test";

import {
  NODEX_DEVELOPMENT_FEATURES_ENV,
  developmentFeatureEnvironment,
  isDevelopmentFeatureEnabled,
  parseDevelopmentFeatureEnvironment,
  resolveDevelopmentFeatureOverrides,
} from "./development-features";

describe("development feature catalog", () => {
  test("normalizes repeated overrides and rejects unknown features", () => {
    expect(resolveDevelopmentFeatureOverrides(["runtime-metrics", " runtime-metrics "])).toEqual([
      "runtime-metrics",
    ]);
    expect(() => resolveDevelopmentFeatureOverrides(["missing"])).toThrow(
      /Available features: nodex-dynamic-tools, database-page-reorder-menu, runtime-metrics/u,
    );
  });

  test("resolves invocation-scoped feature state from one environment key", () => {
    const environment = developmentFeatureEnvironment(["runtime-metrics"]);
    expect(environment).toEqual({
      [NODEX_DEVELOPMENT_FEATURES_ENV]: "runtime-metrics",
    });
    expect(parseDevelopmentFeatureEnvironment(environment)).toEqual(new Set(["runtime-metrics"]));
    expect(isDevelopmentFeatureEnabled("runtime-metrics", environment)).toBe(true);
    expect(isDevelopmentFeatureEnabled("runtime-metrics", {})).toBe(false);
    expect(isDevelopmentFeatureEnabled("nodex-dynamic-tools", {})).toBe(false);
    expect(
      isDevelopmentFeatureEnabled(
        "nodex-dynamic-tools",
        developmentFeatureEnvironment(["nodex-dynamic-tools"]),
      ),
    ).toBe(true);
  });
});
