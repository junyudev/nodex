import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { LoadingPlaceholder } from "@/components/ui/loading-placeholder";
import { LoadingResultsShimmer } from "@/components/ui/loading-results-shimmer";
import { NodexLogoShimmer } from "@/components/ui/nodex-logo-shimmer";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import { REDUCED_MOTION_STORAGE_KEY } from "@/lib/reduced-motion";
import { ReducedMotionProvider } from "@/lib/use-reduced-motion";
import { readLoadingAnimations } from "@/test/loading-motion";
import { BrowserTabFavicon } from "@/features/browser-sidebar/browser-tab-favicon";
import { SubagentAvatar } from "./subagent-avatar";
import { CodexShimmerText } from "./codex-shimmer-text";
import "../../../../globals.css";

interface ChromiumMediaEmulationSession {
  send(
    method: "Emulation.setEmulatedMedia",
    params: {
      features: Array<{
        name: "prefers-reduced-motion";
        value: "no-preference" | "reduce";
      }>;
    },
  ): Promise<unknown>;
}

function renderWithMotionPreference(
  children: ReactNode,
  preference: "system" | "on" | "off" = "off",
) {
  localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, preference);
  const store = createMaitaiStore();
  const view = render(
    <MaitaiProvider store={store}>
      <ReducedMotionProvider>{children}</ReducedMotionProvider>
    </MaitaiProvider>,
  );
  return {
    ...view,
    rerenderWithPreference: (nextChildren: ReactNode) => {
      view.rerender(
        <MaitaiProvider store={store}>
          <ReducedMotionProvider>{nextChildren}</ReducedMotionProvider>
        </MaitaiProvider>,
      );
    },
    dispose: () => {
      view.unmount();
      disposeMaitaiStore(store);
      localStorage.removeItem(REDUCED_MOTION_STORAGE_KEY);
    },
  };
}

describe("loading motion parity in Chromium", () => {
  test("keeps static Subagent identity free of loading timelines", () => {
    const view = renderWithMotionPreference(
      <div data-testid="avatar-root">
        <SubagentAvatar seed="researcher" />
      </div>,
    );

    try {
      expect(readLoadingAnimations(view.getByTestId("avatar-root"))).toEqual([]);
    } finally {
      view.dispose();
    }
  });

  test("runs the cadenced two-transform burst and tears it down between bursts", async () => {
    const view = render(<CodexShimmerText data-testid="cadenced">Running checks</CodexShimmerText>);
    const root = view.getByTestId("cadenced");
    expect(readLoadingAnimations(root)).toEqual([]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    const burst = readLoadingAnimations(root);
    expect(burst).toHaveLength(2);
    expect(burst.every((animation) => animation.durationMs === 1_000)).toBe(true);
    expect(burst.every((animation) => animation.iterationCount === 1)).toBe(true);
    expect(burst.every((animation) => animation.animatedProperties.join(",") === "transform")).toBe(
      true,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_050));
    });
    expect(readLoadingAnimations(root)).toEqual([]);
  });

  test("retains one approved classic background-position shimmer", async () => {
    const view = render(
      <CodexShimmerText data-testid="classic" variant="classic">
        Browser is working
      </CodexShimmerText>,
    );
    const root = view.getByTestId("classic");

    await waitFor(() => expect(readLoadingAnimations(root)).toHaveLength(1));
    const animation = readLoadingAnimations(root)[0];
    expect(animation?.animatedProperties).toEqual(["backgroundPositionX", "backgroundPositionY"]);
    expect(animation?.durationMs).toBe(2_000);
    expect(animation?.iterationCount).toBe(Number.POSITIVE_INFINITY);
  });

  test("uses one contained transform spinner and honors the app override", async () => {
    const active = renderWithMotionPreference(
      <div data-testid="spinner-root" role="status" aria-label="Loading">
        <ActivitySpinnerIcon />
      </div>,
      "off",
    );
    try {
      await waitFor(() => {
        expect(readLoadingAnimations(active.getByTestId("spinner-root"))).toHaveLength(1);
      });
      const animation = readLoadingAnimations(active.getByTestId("spinner-root"))[0];
      expect(animation?.animatedProperties).toEqual(["transform"]);
      expect(animation?.iterationCount).toBe(Number.POSITIVE_INFINITY);
      expect(animation?.hiddenByAncestor).toBe(false);
    } finally {
      active.dispose();
    }

    const reduced = renderWithMotionPreference(
      <div data-testid="reduced-spinner-root" role="status" aria-label="Loading">
        <ActivitySpinnerIcon />
      </div>,
      "on",
    );
    try {
      expect(readLoadingAnimations(reduced.getByTestId("reduced-spinner-root"))).toEqual([]);
    } finally {
      reduced.dispose();
    }
  });

  test("bounds text, placeholder, and startup identity timelines", async () => {
    const view = render(
      <div data-testid="loading-primitives">
        <LoadingResultsShimmer lines={3} />
        <LoadingPlaceholder className="h-20" />
        <NodexLogoShimmer />
      </div>,
    );
    const root = view.getByTestId("loading-primitives");

    await waitFor(() => expect(readLoadingAnimations(root)).toHaveLength(5));
    const animations = readLoadingAnimations(root);
    expect(
      animations.filter((animation) => animation.animatedProperties.join(",") === "transform"),
    ).toHaveLength(4);
    expect(
      animations.filter((animation) => animation.animatedProperties.join(",") === "opacity"),
    ).toHaveLength(1);
  });

  test("unmounts the Browser throbber after its completion transition", async () => {
    const view = renderWithMotionPreference(
      <div data-testid="browser-icon" className="size-4">
        <BrowserTabFavicon
          faviconUrl="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
          isLoading
          isWaitingForResponse={false}
        />
      </div>,
    );
    const root = view.getByTestId("browser-icon");
    try {
      await waitFor(() => expect(readLoadingAnimations(root)).toHaveLength(3));
      expect(root.querySelector("[data-browser-tab-throbber='true']")).not.toBeNull();

      view.rerenderWithPreference(
        <div data-testid="browser-icon" className="size-4">
          <BrowserTabFavicon
            faviconUrl="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
            isLoading={false}
            isWaitingForResponse={false}
          />
        </div>,
      );
      await waitFor(() => {
        expect(
          view.getByTestId("browser-icon").querySelector("[data-browser-tab-throbber='true']"),
        ).toBeNull();
        expect(readLoadingAnimations(view.getByTestId("browser-icon"))).toEqual([]);
      });
    } finally {
      view.dispose();
    }
  });

  test("stops OS-governed CSS loaders under reduced motion", async () => {
    const session = cdp() as unknown as ChromiumMediaEmulationSession;
    const setReducedMotion = async (value: "no-preference" | "reduce") => {
      await act(async () => {
        await session.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value }],
        });
        await Promise.resolve();
      });
    };

    try {
      await setReducedMotion("reduce");
      const view = render(
        <div data-testid="os-reduced-loaders">
          <CodexShimmerText variant="classic">Working</CodexShimmerText>
          <LoadingResultsShimmer lines={3} />
          <LoadingPlaceholder className="h-10" />
          <NodexLogoShimmer />
        </div>,
      );
      try {
        expect(readLoadingAnimations(view.getByTestId("os-reduced-loaders"))).toEqual([]);
      } finally {
        view.unmount();
      }
    } finally {
      await setReducedMotion("no-preference");
    }
  });
});
