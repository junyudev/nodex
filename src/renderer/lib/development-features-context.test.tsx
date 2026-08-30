import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vite-plus/test";

import { DevelopmentFeaturesProvider, useDevelopmentFeature } from "./development-features-context";

describe("DevelopmentFeaturesProvider", () => {
  test("fails closed without startup capabilities", () => {
    const { result } = renderHook(() => useDevelopmentFeature("database-page-reorder-menu"));

    expect(result.current).toBe(false);
  });

  test("projects the immutable Main-owned feature set", () => {
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <DevelopmentFeaturesProvider
        capabilities={{ enabledDevelopmentFeatures: ["database-page-reorder-menu"] }}
      >
        {children}
      </DevelopmentFeaturesProvider>
    );
    const { result } = renderHook(() => useDevelopmentFeature("database-page-reorder-menu"), {
      wrapper,
    });

    expect(result.current).toBe(true);
  });
});
