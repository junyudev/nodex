import { useEffect, useId, useState } from "react";
import { ChevronDownIcon, ResetIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexCollapsiblePanel,
  NodexCollapsibleRoot,
  NodexCollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
} from "@/components/ui/settings";
import { useTheme } from "@/lib/use-theme";
import { useTypographyPreferences } from "@/lib/use-typography-preferences";
import { useReducedMotionPreference } from "@/lib/use-reduced-motion";
import { FONT_SIZE_LIMITS } from "@/lib/typography-preferences";
import type { ResolvedTheme } from "@/lib/theme-preferences";
import { cn } from "@/lib/utils";
import { AccentColorSettingControl } from "./accent-color-setting-control";
import {
  CodeFontSizeSettingControl,
  FontFamilySettingControl,
  PageFontSizeSettingControl,
  ReducedMotionSettingControl,
  SansFontSizeSettingControl,
  ThemeSettingControl,
  TogglePill,
} from "./workbench-settings-controls";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import {
  APPEARANCE_ADVANCED_ANCHOR,
  shouldExpandAppearanceAdvanced,
} from "./workbench-settings-search-catalog";

function ThemeSettingsSection({ title, variant }: { title: string; variant: ResolvedTheme }) {
  return (
    <NodexSettingsSection title={title} titlePlacement="inside">
      <NodexSettingsRow label="Accent color" size="compact">
        <AccentColorSettingControl variant={variant} />
      </NodexSettingsRow>
      <NodexSettingsRow label="Font" size="compact">
        <FontFamilySettingControl role="ui" variant={variant} />
      </NodexSettingsRow>
    </NodexSettingsSection>
  );
}

function ContentFontsSection({ title, variant }: { title?: string; variant: ResolvedTheme }) {
  return (
    <NodexSettingsSection title={title} titlePlacement="inside">
      <NodexSettingsRow label="Content font" size="compact">
        <FontFamilySettingControl role="content" variant={variant} />
      </NodexSettingsRow>
      <NodexSettingsRow label="Code font" size="compact">
        <FontFamilySettingControl role="code" variant={variant} />
      </NodexSettingsRow>
    </NodexSettingsSection>
  );
}

export function AppearanceSettingsPage({
  initialSearchQuery,
  settingsAnchor,
}: Pick<SettingsSectionPageProps, "initialSearchQuery" | "settingsAnchor"> = {}) {
  const { resolved } = useTheme();
  const { setFontSize, setFontFamily } = useTypographyPreferences();
  const { setPreference: setReducedMotion } = useReducedMotionPreference();
  const visualStyleTitleId = useId();
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      settingsAnchor === APPEARANCE_ADVANCED_ANCHOR ||
      shouldExpandAppearanceAdvanced(initialSearchQuery),
  );
  const [separateModes, setSeparateModes] = useState(false);
  const variants: readonly ResolvedTheme[] = separateModes ? ["light", "dark"] : [resolved];
  const resetAdvanced = () => {
    for (const role of ["ui", "page", "code"] as const) {
      setFontSize(role, FONT_SIZE_LIMITS[role].default);
    }
    for (const variant of ["light", "dark"] as const) {
      for (const role of ["content", "code"] as const) {
        setFontFamily(variant, role, null);
      }
    }
    setReducedMotion("system");
    setSeparateModes(false);
  };
  useEffect(() => {
    if (
      settingsAnchor !== APPEARANCE_ADVANCED_ANCHOR &&
      !shouldExpandAppearanceAdvanced(initialSearchQuery)
    ) {
      return;
    }
    setAdvancedOpen(true);
    if (settingsAnchor === APPEARANCE_ADVANCED_ANCHOR) {
      document.getElementById(APPEARANCE_ADVANCED_ANCHOR)?.scrollIntoView({ block: "start" });
    }
  }, [initialSearchQuery, settingsAnchor]);

  return (
    <NodexSettingsPageSurface title="Appearance">
      <section aria-labelledby={visualStyleTitleId} className="flex flex-col gap-4">
        <h2 id={visualStyleTitleId} className="text-base font-medium text-token-text-primary">
          Visual style
        </h2>
        <NodexSettingsSection>
          <NodexSettingsRow label="Mode" variant="nested">
            <ThemeSettingControl />
          </NodexSettingsRow>
        </NodexSettingsSection>

        {variants.map((variant) => (
          <ThemeSettingsSection
            key={variant}
            title={separateModes ? `${variant === "light" ? "Light" : "Dark"} theme` : "Theme"}
            variant={variant}
          />
        ))}
      </section>

      <NodexCollapsibleRoot
        id={APPEARANCE_ADVANCED_ANCHOR}
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h2>
            <NodexCollapsibleTrigger
              render={
                <button
                  type="button"
                  className="inline-flex min-h-7 cursor-interaction items-center gap-1.5 rounded-md text-base font-medium text-tertiary hover:text-(--color-text) outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
                />
              }
            >
              <ChevronDownIcon className={cn("size-3.5", !advancedOpen && "-rotate-90")} />
              Advanced
            </NodexCollapsibleTrigger>
          </h2>
          {advancedOpen ? (
            <NodexButton
              aria-label="Reset advanced appearance"
              onClick={resetAdvanced}
              variant="ghost"
              size="xs"
              className="gap-1 text-token-text-secondary"
            >
              <ResetIcon className="size-3.5" />
              Reset
            </NodexButton>
          ) : null}
        </div>
        <NodexCollapsiblePanel className="mt-2 flex flex-col gap-4 data-[closed]:hidden">
          <NodexSettingsSection>
            <NodexSettingsRow label="UI font size">
              <SansFontSizeSettingControl />
            </NodexSettingsRow>
            <NodexSettingsRow label="Content font size" description="Pages">
              <PageFontSizeSettingControl />
            </NodexSettingsRow>
            <NodexSettingsRow label="Code font size">
              <CodeFontSizeSettingControl />
            </NodexSettingsRow>
          </NodexSettingsSection>
          <NodexSettingsSection>
            <NodexSettingsRow label="Reduce motion">
              <ReducedMotionSettingControl />
            </NodexSettingsRow>
            <NodexSettingsRow label="Separate light/dark modes">
              <TogglePill
                ariaLabel="Separate light/dark modes"
                value={separateModes}
                onChange={setSeparateModes}
              />
            </NodexSettingsRow>
          </NodexSettingsSection>
          {variants.map((variant) => (
            <ContentFontsSection
              key={variant}
              title={separateModes ? `${variant === "light" ? "Light" : "Dark"} theme` : undefined}
              variant={variant}
            />
          ))}
        </NodexCollapsiblePanel>
      </NodexCollapsibleRoot>
    </NodexSettingsPageSurface>
  );
}
