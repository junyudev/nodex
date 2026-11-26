import { useIntl } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { NodexButton } from "@/components/ui/button";
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
import { AccentColorSettingControl } from "./accent-color-setting-control";
import { UsageMeterSettingRows } from "./usage-meter-setting-rows";
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
  settingsMessages,
  APPEARANCE_ADVANCED_ANCHOR,
  shouldExpandAppearanceAdvanced,
} from "./workbench-settings-search-catalog";

/** Accent and interface font for one color mode. */
function ThemeSettingsRows({ variant }: { variant: ResolvedTheme }) {
  const intl = useIntl();
  return (
    <>
      <NodexSettingsRow
        label={intl.formatMessage(settingsMessages.appearanceAccentColor2)}
        description={intl.formatMessage({
          id: "settings.appearance.accentColorDescription",
          defaultMessage: "Set the color for highlights and selected controls",
        })}
      >
        <AccentColorSettingControl variant={variant} />
      </NodexSettingsRow>
      <NodexSettingsRow
        label={intl.formatMessage(settingsMessages.appearanceFont)}
        description={intl.formatMessage({
          id: "settings.appearance.fontDescription",
          defaultMessage: "Set the font for menus and controls",
        })}
      >
        <FontFamilySettingControl role="ui" variant={variant} />
      </NodexSettingsRow>
    </>
  );
}

function ContentFontsSection({ title, variant }: { title?: string; variant: ResolvedTheme }) {
  const intl = useIntl();
  return (
    <NodexSettingsSection title={title}>
      <NodexSettingsRow
        label={intl.formatMessage(settingsMessages.appearanceContentFont)}
        size="compact"
      >
        <FontFamilySettingControl role="content" variant={variant} />
      </NodexSettingsRow>
      <NodexSettingsRow
        label={intl.formatMessage(settingsMessages.appearanceCodeFont)}
        size="compact"
      >
        <FontFamilySettingControl role="code" variant={variant} />
      </NodexSettingsRow>
    </NodexSettingsSection>
  );
}

export function AppearanceSettingsPage({
  initialSearchQuery,
  isMacPlatform = false,
  settingsAnchor,
}: Partial<
  Pick<SettingsSectionPageProps, "initialSearchQuery" | "isMacPlatform" | "settingsAnchor">
> = {}) {
  const intl = useIntl();
  const { resolved } = useTheme();
  const { preferences, setFontSize, setFontFamily, setFontSmoothing } = useTypographyPreferences();
  const { setPreference: setReducedMotion } = useReducedMotionPreference();
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
    setFontSmoothing(true);
    setReducedMotion("system");
    setSeparateModes(false);
  };
  const [advancedInput, setAdvancedInput] = useState({ initialSearchQuery, settingsAnchor });
  if (
    advancedInput.initialSearchQuery !== initialSearchQuery ||
    advancedInput.settingsAnchor !== settingsAnchor
  ) {
    setAdvancedInput({ initialSearchQuery, settingsAnchor });
    if (
      settingsAnchor === APPEARANCE_ADVANCED_ANCHOR ||
      shouldExpandAppearanceAdvanced(initialSearchQuery)
    )
      setAdvancedOpen(true);
  }
  useEffect(() => {
    if (advancedInput.settingsAnchor !== APPEARANCE_ADVANCED_ANCHOR) return;
    document.getElementById(advancedInput.settingsAnchor)?.scrollIntoView({ block: "start" });
  }, [advancedInput]);

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage(settingsMessages.appearanceTitle)}
      subtitle={intl.formatMessage(settingsMessages.appearanceSubtitle)}
    >
      <NodexSettingsSection title={intl.formatMessage(settingsMessages.appearanceVisualStyle)}>
        <NodexSettingsRow
          label={intl.formatMessage(settingsMessages.appearanceMode)}
          description={intl.formatMessage({
            id: "settings.appearance.modeDescription",
            defaultMessage: "Use light or dark colors, or follow your system setting",
          })}
        >
          <ThemeSettingControl />
        </NodexSettingsRow>
        {separateModes ? null : <ThemeSettingsRows variant={resolved} />}
      </NodexSettingsSection>

      {separateModes
        ? (["light", "dark"] as const).map((variant) => (
            <NodexSettingsSection
              key={variant}
              title={intl.formatMessage(
                { id: "settings.appearance.theme", defaultMessage: "{value} theme" },
                {
                  value: intl.formatMessage(
                    variant === "light"
                      ? settingsMessages.appearanceLight
                      : settingsMessages.appearanceDark,
                  ),
                },
              )}
            >
              <ThemeSettingsRows variant={variant} />
            </NodexSettingsSection>
          ))
        : null}

      <UsageMeterSettingRows />

      <NodexSettingsSection
        id={APPEARANCE_ADVANCED_ANCHOR}
        title={intl.formatMessage(settingsMessages.appearanceAdvanced)}
        disclosure={{ open: advancedOpen, onOpenChange: setAdvancedOpen }}
        disclosureHeading="quiet"
        action={
          <NodexButton
            aria-label={intl.formatMessage(settingsMessages.appearanceResetAdvancedAppearance)}
            onClick={resetAdvanced}
            variant="ghostSecondary"
            size="toolbar"
          >
            {intl.formatMessage(settingsMessages.appearanceReset)}
          </NodexButton>
        }
      >
        <div className="flex flex-col gap-4">
          <NodexSettingsSection>
            <NodexSettingsRow label={intl.formatMessage(settingsMessages.appearanceUIFontSize)}>
              <SansFontSizeSettingControl />
            </NodexSettingsRow>
            <NodexSettingsRow
              label={intl.formatMessage(settingsMessages.appearanceContentFontSize)}
              description={intl.formatMessage(settingsMessages.appearancePages)}
            >
              <PageFontSizeSettingControl />
            </NodexSettingsRow>
            <NodexSettingsRow label={intl.formatMessage(settingsMessages.appearanceCodeFontSize)}>
              <CodeFontSizeSettingControl />
            </NodexSettingsRow>
          </NodexSettingsSection>
          <NodexSettingsSection>
            {isMacPlatform ? (
              <NodexSettingsRow
                label={intl.formatMessage(settingsMessages.appearanceFontSmoothing)}
              >
                <TogglePill
                  ariaLabel={intl.formatMessage(settingsMessages.appearanceFontSmoothing)}
                  value={preferences.useFontSmoothing}
                  onChange={setFontSmoothing}
                />
              </NodexSettingsRow>
            ) : null}
            <NodexSettingsRow label={intl.formatMessage(settingsMessages.appearanceReduceMotion)}>
              <ReducedMotionSettingControl />
            </NodexSettingsRow>
            <NodexSettingsRow
              label={intl.formatMessage(settingsMessages.appearanceSeparateLightDarkModes)}
            >
              <TogglePill
                ariaLabel={intl.formatMessage(settingsMessages.appearanceSeparateLightDarkModes)}
                value={separateModes}
                onChange={setSeparateModes}
              />
            </NodexSettingsRow>
          </NodexSettingsSection>
          {variants.map((variant) => (
            <ContentFontsSection
              key={variant}
              title={
                separateModes
                  ? intl.formatMessage(
                      { id: "settings.appearance.theme", defaultMessage: "{value} theme" },
                      {
                        value: intl.formatMessage(
                          variant === "light"
                            ? settingsMessages.appearanceLight
                            : settingsMessages.appearanceDark,
                        ),
                      },
                    )
                  : undefined
              }
              variant={variant}
            />
          ))}
        </div>
      </NodexSettingsSection>
    </NodexSettingsPageSurface>
  );
}
